// @ts-nocheck
import express, { Request, Response, NextFunction } from "express"
import compression from "compression"
import cors from "cors"
import { PregenIdentifierType, Capsule } from "@usecapsule/server-sdk"
import rateLimit from "express-rate-limit"
import NodeCache from "node-cache"
import pino from "pino"
import { NFT_CONTRACT_ADDRESS, NFT_CONTRACT_ABI } from "./constants.js"
import {
  initializeCapsule,
  createOrGetPregenWallet,
  createViemClient,
  createAlchemyClient,
} from "./clients.js"
import { encodeFunctionData } from "viem"
import type { SendUserOperationResult } from "@alchemy/aa-core"
import helmet from "helmet"


// Logger configuration with proper typings
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
})

// Type definitions
interface MintRequest extends Express.Request {
  body: {
    email?: string
    phone?: string
  }
}

interface MintResult {
  status: string
  identifier: string
  identifierType: PregenIdentifierType
  walletAddress: string
  operationHash: string
}

interface ErrorResponse {
  error: string
  retryAfter?: number
  details?: string
  message?: string
  stack?: string
}

// Custom error classes with proper typing
class CapsuleInitializationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CapsuleInitializationError"
    Object.setPrototypeOf(this, CapsuleInitializationError.prototype)
  }
}

class WalletOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WalletOperationError"
    Object.setPrototypeOf(this, WalletOperationError.prototype)
  }
}

// Configuration with explicit typing
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "3600")
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || "900000")
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100")
const CIRCUIT_BREAKER_THRESHOLD = parseInt(
  process.env.CIRCUIT_BREAKER_THRESHOLD || "10"
)
const CIRCUIT_BREAKER_RESET_TIME = parseInt(
  process.env.CIRCUIT_BREAKER_RESET_TIME || "300000"
)
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3")
const INITIAL_RETRY_DELAY = parseInt(process.env.INITIAL_RETRY_DELAY || "1000")

// Express initialization
const app = express()

app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))
app.use(
  cors({
    origin: "*",
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
)
app.use(helmet())

// Cache initialization with typing
const cache = new NodeCache({
  stdTTL: CACHE_TTL,
  checkperiod: CACHE_TTL / 30,
  useClones: false,
})

// Rate limiter with proper typing
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  message: { error: "Too many requests, please try again later" } as ErrorResponse,
  standardHeaders: true,
  legacyHeaders: false,
})

// Circuit Breaker implementation with proper typing
class CircuitBreaker {
  private failures: number = 0
  private lastFailure: number = Date.now()
  private isOpen: boolean = false

  public isCircuitOpen(): boolean {
    if (this.isOpen) {
      if (Date.now() - this.lastFailure > CIRCUIT_BREAKER_RESET_TIME) {
        this.reset()
        return false
      }
      return true
    }
    return false
  }

  public recordFailure(): void {
    this.failures++
    this.lastFailure = Date.now()
    if (this.failures > CIRCUIT_BREAKER_THRESHOLD) {
      this.isOpen = true
    }
  }

  public reset(): void {
    this.failures = 0
    this.isOpen = false
  }
}

const circuitBreaker = new CircuitBreaker()

// Validation functions with proper typing
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

function isValidPhone(phone: string): boolean {
  const phoneRegex = /^\+[1-9]\d{1,14}$/
  return phoneRegex.test(phone)
}

// Middleware with proper typing
const validateRequest = (
  req: MintRequest,
  res: Response<ErrorResponse>,
  next: NextFunction
): void => {
  try {
    const { email, phone } = req.body;

    if (!email && !phone) {
      res.status(400).json({ error: "Either email or phone is required" });
      return;
    }

    if (email) {
      if (!isValidEmail(email)) {
        res.status(400).json({ error: "Invalid email format" });
        return;
      }
      req.body.email = email.toLowerCase().trim();
    }

    if (phone) {
      if (!isValidPhone(phone)) {
        res.status(400).json({
          error: "Invalid phone format. Use international format (e.g. +5511999999999)",
        });
        return;
      }
      req.body.phone = phone.trim();
    }

    next();
  } catch (error) {
    logger.error({ error }, "Error in request validation");
    next(error);
  }
};

const cacheMiddleware = (
  req: MintRequest,
  res: Response,
  next: NextFunction
): void => {
  try {
    const identifier = req.body.email || req.body.phone
    if (!identifier) {
      next()
      return
    }

    const cachedResult = cache.get<MintResult>(`mint:${identifier}`)
    if (cachedResult) {
      logger.info({ identifier }, "Cache hit for mint request")
      res.json(cachedResult)
      return
    }

    next()
  } catch (error) {
    logger.error({ error }, "Error in cache middleware")
    next(error)
  }
}

const circuitBreakerMiddleware = (
  req: Request,
  res: Response<ErrorResponse>,
  next: NextFunction
): void => {
  if (circuitBreaker.isCircuitOpen()) {
    logger.warn("Circuit breaker is open, rejecting request")
    res.status(503).json({
      error: "Service temporarily unavailable",
      retryAfter: CIRCUIT_BREAKER_RESET_TIME / 1000,
    })
    return
  }
  next()
}

// Main mint function with proper typing
async function performMint(req: MintRequest): Promise<MintResult> {
  const { email, phone } = req.body
  const identifier = email || phone
  if (!identifier) {
    throw new Error("No identifier provided")
  }

  const identifierType = email
    ? PregenIdentifierType.EMAIL
    : PregenIdentifierType.PHONE

  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      logger.info({ attempt, identifier }, "Attempting mint operation")

      const capsuleClient = await initializeCapsule()
      const wallet = await createOrGetPregenWallet(
        capsuleClient,
        identifier,
        identifierType,
        logger
      )

      if (!wallet || !wallet.address) {
        throw new Error("Failed to create or get wallet")
      }

      const viemClient = await createViemClient(capsuleClient)
      const alchemyClient = await createAlchemyClient(viemClient)

      const mintCallData = {
        target: NFT_CONTRACT_ADDRESS as `0x${string}`,
        data: encodeFunctionData({
          abi: NFT_CONTRACT_ABI,
          functionName: "mintTo",
          args: [wallet.address],
        }),
      }

      const userOperationResult = await alchemyClient.sendUserOperation({
        uo: [mintCallData],
      })

      const result: MintResult = {
        status: "success",
        identifier,
        identifierType,
        walletAddress: wallet.address,
        operationHash: userOperationResult.hash,
      }

      logger.info(
        {
          identifier,
          walletAddress: wallet.address,
          operationHash: userOperationResult.hash,
        },
        "Mint operation successful"
      )

      return result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error')
      logger.error(
        {
          error,
          attempt,
          identifier,
        },
        "Mint attempt failed"
      )

      if (attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError || new Error("Max retries exceeded")
}

// Request handlers with proper typing
const mintHandler = async (
  req: MintRequest,
  res: Response<MintResult | ErrorResponse>
): Promise<void> => {
  const startTime = Date.now()
  const identifier = req.body.email || req.body.phone

  try {
    logger.info({ identifier }, "Starting mint process")

    try {
      const capsuleClient = await initializeCapsule()
      logger.info({ identifier }, "Capsule initialized successfully")
    } catch (error) {
      logger.error({ error, identifier }, "Failed to initialize Capsule")
      res.status(503).json({
        error: "Service initialization failed",
        retryAfter: 60,
        details: "Failed to initialize necessary services",
      })
      return
    }

    const result = await performMint(req)
    if (identifier) {
      cache.set(`mint:${identifier}`, result)
    }
    circuitBreaker.reset()

    const duration = Date.now() - startTime
    logger.info(
      { identifier, duration, result },
      "Mint request completed successfully"
    )

    res.json(result)
  } catch (error) {
    const duration = Date.now() - startTime
    const errorDetails = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : { message: 'Unknown error' }

    logger.error(
      {
        error: errorDetails,
        identifier,
        duration,
      },
      "Mint request failed"
    )

    circuitBreaker.recordFailure()

    if (error instanceof CapsuleInitializationError) {
      res.status(503).json({
        error: "Service temporarily unavailable",
        retryAfter: CIRCUIT_BREAKER_RESET_TIME / 1000,
        details: "Failed to initialize Capsule service",
      })
      return
    }

    if (error instanceof WalletOperationError) {
      res.status(500).json({
        error: "Wallet operation failed",
        retryAfter: 60,
        details:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Wallet operation error",
      })
      return
    }

    res.status(500).json({
      error: "Failed to mint NFT",
      retryAfter: CIRCUIT_BREAKER_RESET_TIME / 1000,
      details:
        process.env.NODE_ENV === "development"
          ? errorDetails.message
          : "Internal server error",
    })
  }
}

// Routes with proper typing
app.get("/health", async (req: Request, res: Response): Promise<void> => {
  try {
    const capsuleClient = await initializeCapsule()
    const viemClient = await createViemClient(capsuleClient)
    const alchemyClient = await createAlchemyClient(viemClient)

    res.json({
      status: "healthy",
      capsule: !!capsuleClient,
      viem: !!viemClient,
      alchemy: !!alchemyClient,
      env: {
        hasNFTAddress: !!NFT_CONTRACT_ADDRESS,
        hasNFTAbi: !!NFT_CONTRACT_ABI,
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error({ error }, "Health check failed")
    res.status(500).json({
      status: "unhealthy",
      error: errorMessage,
    })
  }
})

app.post(
  "/mint",
  limiter,
  validateRequest,
  cacheMiddleware,
  circuitBreakerMiddleware,
  mintHandler
)

// Global error handler with proper typing
const errorHandler = (
  err: Error,
  req: Request,
  res: Response<ErrorResponse>,
  next: NextFunction
): void => {
  logger.error(
    { err, req: { method: req.method, url: req.url } },
    "Unhandled error"
  )

  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  })
}

app.use(errorHandler)

// Server initialization
const port = Number(process.env.PORT) || 8080
app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`)
})

export default app