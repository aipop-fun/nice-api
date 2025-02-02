import dotenv from "dotenv"
import { Environment } from "@usecapsule/server-sdk"


dotenv.config()

// Helper function to get environment variables
function getEnvVariable(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Environment variable ${key} is not set`)
  }
  return value
}

// Server configuration
export const PORT = process.env.PORT || 8080

// Capsule configuration
export const CAPSULE_API_KEY = getEnvVariable("CAPSULE_API_KEY")
export const CAPSULE_ENVIRONMENT = Environment.BETA

// Alchemy configuration. Please see https://dashboard.alchemy.com/ for your API key and gas policy ID
export const ALCHEMY_API_KEY = getEnvVariable("ALCHEMY_API_KEY")
export const ALCHEMY_GAS_POLICY_ID = getEnvVariable("ALCHEMY_GAS_POLICY_ID")
export const ALCHEMY_RPC_URL = `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`


export const NFT_CONTRACT_ADDRESS = "0xb8db917bd55DEAec469236Ace6058f2fa76791E6"
export const NFT_CONTRACT_ABI = [
  {
    inputs: [],
    name: "mint",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "to",
        type: "address"
      }
    ],
    name: "mintTo",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  }
]

export const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:8080",
  "https://capsule.aipop.fun",
]


export const MAX_RETRIES = 3
export const RETRY_DELAY = 1000 


export const DEFAULT_GAS_LIMIT = 300000
export const DEFAULT_TIMEOUT = 30000 
