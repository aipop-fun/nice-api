// @ts-nocheck

import { createClient } from "@supabase/supabase-js"
import { PregenIdentifierType } from "@usecapsule/server-sdk"

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

const TABLE_NAME = "user_shares"

interface UserShareData {
  identifier: string
  identifier_type: PregenIdentifierType
  user_share: string
  created_at: string
}

export async function storeUserShare(
  identifier: string,
  userShare: string,
  identifierType: PregenIdentifierType
): Promise<void> {
  try {
    const { error } = await supabase.from(TABLE_NAME).insert([
      {
        identifier,
        identifier_type: identifierType,
        user_share: userShare,
        // Supabase handles timestamps automatically when column is set to type timestamp with default now()
      },
    ])

    if (error) throw error
  } catch (error) {
    console.error("Error storing user share:", error)
    throw new Error("Failed to store user share")
  }
}

export async function getUserShareFromDatabase(
  identifier: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("user_share")
      .eq("identifier", identifier)
      .single()

    if (error) throw error
    return data?.user_share || null
  } catch (error) {
    console.error("Error getting user share:", error)
    throw new Error("Failed to get user share")
  }
}

export async function getIdentifierTypeFromDatabase(
  identifier: string
): Promise<PregenIdentifierType | null> {
  try {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("identifier_type")
      .eq("identifier", identifier)
      .single()

    if (error) throw error
    return data?.identifier_type || null
  } catch (error) {
    console.error("Error getting identifier type:", error)
    throw new Error("Failed to get identifier type")
  }
}

export async function identifierExists(identifier: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("identifier")
      .eq("identifier", identifier)
      .single()

    if (error && error.code === "PGRST116") {
      // PGRST116 means no rows returned
      return false
    }

    if (error) throw error
    return !!data
  } catch (error) {
    console.error("Error checking identifier:", error)
    throw new Error("Failed to check identifier")
  }
}
