// @ts-nocheck
import {
  Capsule,
  WalletType,
  PregenIdentifierType,
  Wallet,
  hexStringToBase64,
  SuccessfulSignatureRes,
} from "@usecapsule/server-sdk"
import {
  createCapsuleViemClient,
  createCapsuleAccount,
} from "@usecapsule/viem-v2-integration"
import { createModularAccountAlchemyClient } from "@alchemy/aa-alchemy"
import { WalletClientSigner, baseSepolia } from "@alchemy/aa-core"
import {
  http,
  WalletClientConfig,
  WalletClient,
  SignableMessage,
  Hash,
  hashMessage,
} from "viem"
import {
  CAPSULE_API_KEY,
  CAPSULE_ENVIRONMENT,
  ALCHEMY_RPC_URL,
  ALCHEMY_API_KEY,
  ALCHEMY_GAS_POLICY_ID,
} from "./constants"
import { getUserShareFromDatabase, storeUserShare } from "./database"

// Custom error classes
class CapsuleInitializationError extends Error {
  constructor(
    message: string,
    public readonly originalError?: Error
  ) {
    super(message)
    this.name = "CapsuleInitializationError"
  }
}

class WalletOperationError extends Error {
  constructor(
    message: string,
    public readonly originalError?: Error
  ) {
    super(message)
    this.name = "WalletOperationError"
  }
}

class SigningError extends Error {
  constructor(
    message: string,
    public readonly originalError?: Error
  ) {
    super(message)
    this.name = "SigningError"
  }
}

// Retry configuration
const MAX_RETRIES = 3
const RETRY_DELAY = 1000 // ms

// Helper function for delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Helper function for retrying operations
async function retry<T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  retryDelay: number = RETRY_DELAY
): Promise<T> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error as Error
      if (attempt === maxRetries) break

      console.warn(
        `Attempt ${attempt} failed, retrying in ${retryDelay}ms...`,
        error
      )
      await delay(retryDelay)
    }
  }

  throw lastError
}

export async function initializeCapsule(): Promise<Capsule> {
  try {
    if (!CAPSULE_API_KEY || !CAPSULE_ENVIRONMENT) {
      throw new CapsuleInitializationError(
        "Missing required environment variables"
      )
    }

    return await retry(async () => {
      const capsule = new Capsule(CAPSULE_ENVIRONMENT, CAPSULE_API_KEY)
      // Test the connection
      try {
        const wallets = await capsule.getWallets()
        if (!wallets) {
          throw new Error("Failed to connect to Capsule")
        }
      } catch (error) {
        throw new CapsuleInitializationError(
          "Failed to initialize Capsule SDK",
          error as Error
        )
      }
      return capsule
    })
  } catch (error) {
    throw new CapsuleInitializationError(
      "Failed to initialize Capsule",
      error as Error
    )
  }
}

interface Logger {
  error: (...args: any[]) => void
  info: (...args: any[]) => void
  debug: (...args: any[]) => void
}

const defaultLogger: Logger = {
  error: console.error,
  info: console.info,
  debug: console.debug,
}

export async function createOrGetPregenWallet(
  capsule: Capsule,
  identifier: string,
  identifierType: PregenIdentifierType,
  logger: Logger = defaultLogger
): Promise<Wallet> {
  if (!identifier || !identifierType) {
    logger.error(
      { identifier, identifierType },
      "Invalid identifier or identifier type"
    )
    throw new WalletOperationError("Invalid identifier or identifier type")
  }

  try {
    logger.info({ identifier, identifierType }, "Checking if wallet exists")
    const hasWallet = await retry(async () => {
      const result = await capsule.hasPregenWallet(identifier, identifierType)
      logger.debug(
        { identifier, hasWallet: result },
        "Wallet existence check result"
      )
      return result
    })

    if (!hasWallet) {
      logger.info({ identifier }, "Creating new wallet")
      const pregenWallet = await retry(async () => {
        const wallet = await capsule.createWalletPreGen(
          WalletType.EVM,
          identifier,
          identifierType
        )
        logger.debug({ identifier, walletId: wallet.id }, "Wallet created")
        return wallet
      })

      logger.info({ identifier }, "Getting user share")
      const userShare = await retry(async () => {
        const share = await capsule.getUserShare()
        if (!share) {
          logger.error({ identifier }, "Failed to get user share")
          throw new WalletOperationError("Failed to get user share")
        }
        return share
      })

      logger.info({ identifier }, "Storing user share")
      await retry(() => storeUserShare(identifier, userShare, identifierType))
      return pregenWallet
    }

    logger.info({ identifier }, "Getting existing user share from database")
    const userShare = await retry(() => getUserShareFromDatabase(identifier))
    if (!userShare) {
      logger.error({ identifier }, "User share not found in database")
      throw new WalletOperationError("User share not found in database")
    }

    logger.info({ identifier }, "Setting user share in capsule")
    await retry(() => capsule.setUserShare(userShare))

    logger.info({ identifier }, "Getting wallets")
    const wallets = capsule.getWallets()

    const wallet = Object.values(wallets)[0]
    if (!wallet) {
      logger.error({ identifier }, "No wallet found after setting user share")
      throw new WalletOperationError("No wallet found after setting user share")
    }

    logger.info(
      { identifier, walletAddress: wallet.address },
      "Successfully retrieved wallet"
    )
    return wallet
  } catch (error) {
    const err = error as Error
    logger.error(
      {
        error,
        identifier,
        identifierType,
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      },
      "Wallet operation failed"
    )
    throw new WalletOperationError("Wallet operation failed", err)
  }
}

export function createViemClient(capsule: Capsule): WalletClient {
  if (!capsule?.wallets) {
    throw new WalletOperationError(
      "Capsule instance is not properly initialized"
    )
  }

  try {
    const viemCapsuleAccount = createCapsuleAccount(capsule)

    if (!ALCHEMY_RPC_URL) {
      throw new WalletOperationError("Missing Alchemy RPC URL")
    }

    const walletClientConfig: WalletClientConfig = {
      account: viemCapsuleAccount,
      chain: baseSepolia,
      transport: http(ALCHEMY_RPC_URL),
    }

    const viemClient = createCapsuleViemClient(capsule, walletClientConfig)

    viemClient.signMessage = async ({
      message,
    }: {
      message: SignableMessage
    }): Promise<Hash> => {
      return customSignMessage(capsule, message)
    }

    return viemClient
  } catch (error) {
    throw new WalletOperationError(
      "Failed to create Viem client",
      error as Error
    )
  }
}

export async function createAlchemyClient(viemClient: WalletClient) {
  try {
    if (!ALCHEMY_API_KEY || !ALCHEMY_GAS_POLICY_ID) {
      throw new WalletOperationError("Missing required Alchemy configuration")
    }

    const walletClientSigner: WalletClientSigner = new WalletClientSigner(
      viemClient,
      "capsule"
    )

    return await retry(async () => {
      const client = await createModularAccountAlchemyClient({
        apiKey: ALCHEMY_API_KEY,
        chain: baseSepolia,
        signer: walletClientSigner,
        gasManagerConfig: {
          policyId: ALCHEMY_GAS_POLICY_ID,
        },
      })
      return client
    })
  } catch (error) {
    throw new WalletOperationError(
      "Failed to create Alchemy client",
      error as Error
    )
  }
}

async function customSignMessage(
  capsule: Capsule,
  message: SignableMessage
): Promise<Hash> {
  try {
    if (!capsule?.wallets) {
      throw new SigningError("Capsule instance is not properly initialized")
    }

    const wallet = Object.values(capsule.wallets)[0]
    if (!wallet) {
      throw new SigningError("No wallet available for signing")
    }

    const hashedMessage = hashMessage(message)

    const res = await retry(async () => {
      const signatureResult = await capsule.signMessage(
        wallet.id,
        hexStringToBase64(hashedMessage)
      )
      return signatureResult
    })

    let signature = (res as SuccessfulSignatureRes).signature

    // Validate signature format
    if (!signature || typeof signature !== "string") {
      throw new SigningError("Invalid signature format received")
    }

    // Fix the v value of the signature
    const lastByte = parseInt(signature.slice(-2), 16)
    if (lastByte < 27) {
      const adjustedV = (lastByte + 27).toString(16).padStart(2, "0")
      signature = signature.slice(0, -2) + adjustedV
    }

    return `0x${signature}`
  } catch (error) {
    throw new SigningError("Message signing failed", error as Error)
  }
}
