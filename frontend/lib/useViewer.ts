"use client";

import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";

/**
 * Whose positions to display.
 *
 * Normally the connected wallet. `?as=0x…` overrides it with a read-only view, which is what makes
 * the seeded demo accounts inspectable without handing anyone a private key.
 */
export function useViewer(): { address?: Address; readOnly: boolean; connected: boolean } {
  const { address, isConnected } = useAccount();
  const params = useSearchParams();
  const as = params.get("as");

  if (as && isAddress(as)) {
    return { address: as as Address, readOnly: true, connected: isConnected };
  }
  return { address, readOnly: false, connected: isConnected };
}
