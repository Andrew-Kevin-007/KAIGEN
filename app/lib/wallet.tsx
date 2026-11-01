"use client";

// Wallet connection through FastNEAR's wallet package (near-connect). The wallet holds the keys and asks the
// person to approve each call; this app never sees a key. The package is imported on demand because it touches
// the browser.
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { disconnectOutcome, errorText } from "@/lib/errors";
import { NETWORK } from "@/lib/network";

const TGAS = (n: number) => String(BigInt(n) * 10n ** 12n);

export interface WalletCall {
  receiver: string;
  method: string;
  args?: Record<string, unknown>;
  gasTgas: number;
  /** In yoctoNEAR, as an integer string. Defaults to zero. */
  deposit?: string;
}

interface WalletState {
  account: string | null;
  busy: boolean;
  /** Why the last connect or disconnect failed, or "". Shown next to the Connect wallet buttons. */
  error: string;
  connect: () => Promise<void>;
  /** Never rejects: a failure lands in `error`. */
  disconnect: () => Promise<void>;
  clearError: () => void;
  call: (c: WalletCall) => Promise<void>;
  /** One transaction of any actions (as built by `actions` from @fastnear/api), returning the wallet's outcome. */
  sendTx: (receiver: string, actions: unknown[]) => Promise<unknown>;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet needs <WalletProvider>");
  return v;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // No wallet code at all on the key page: it has a strict policy and never needs a wallet.
  const onKeyPage = usePathname() === "/migrate";

  const load = useCallback(async () => {
    const [w, api] = await Promise.all([import("@fastnear/wallet"), import("@fastnear/api")]);
    return { w, actions: api.actions };
  }, []);

  // Pick the session back up after a reload.
  useEffect(() => {
    if (onKeyPage) return;
    let live = true;
    (async () => {
      try {
        const { w } = await load();
        w.onConnect((r: { accountId?: string }) => live && setAccount(r?.accountId ?? w.accountId({ network: NETWORK }) ?? null));
        w.onDisconnect(() => live && setAccount(null));
        await w.restore({ network: NETWORK });
        if (live && w.isConnected({ network: NETWORK })) setAccount(w.accountId({ network: NETWORK }) ?? null);
      } catch {
        // No saved session, or the wallet code could not load: the person can still press Connect.
      }
    })();
    return () => {
      live = false;
    };
  }, [load, onKeyPage]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const { w } = await load();
      const r = await w.connect({ network: NETWORK });
      if (r?.accountId) setAccount(r.accountId);
    } catch (e) {
      setError(errorText(e, "Could not connect a wallet."));
    } finally {
      setBusy(false);
    }
  }, [load]);

  // The page stops treating the person as connected whatever the wallet says; a failure is shown, not thrown.
  const disconnect = useCallback(async () => {
    setError("");
    const problem = await disconnectOutcome(async () => {
      const { w } = await load();
      await w.disconnect({ network: NETWORK });
    });
    setAccount(null);
    if (problem) setError(problem);
  }, [load]);

  const clearError = useCallback(() => setError(""), []);

  const call = useCallback(
    async (c: WalletCall) => {
      setError("");
      const { w, actions } = await load();
      if (!w.isConnected({ network: NETWORK })) throw new Error("Connect a wallet first.");
      await w.sendTransaction({
        receiverId: c.receiver,
        actions: [actions.functionCall({ methodName: c.method, args: c.args ?? {}, gas: TGAS(c.gasTgas), deposit: c.deposit ?? "0" })],
        network: NETWORK,
      });
    },
    [load],
  );

  const sendTx = useCallback(
    async (receiver: string, actions: unknown[]) => {
      setError("");
      const { w } = await load();
      if (!w.isConnected({ network: NETWORK })) throw new Error("Connect a wallet first.");
      return w.sendTransaction({ receiverId: receiver, actions, network: NETWORK });
    },
    [load],
  );

  const value = useMemo(
    () => ({ account, busy, error, connect, disconnect, clearError, call, sendTx }),
    [account, busy, error, connect, disconnect, clearError, call, sendTx],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
