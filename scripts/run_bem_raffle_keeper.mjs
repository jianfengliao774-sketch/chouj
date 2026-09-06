// Keeper for the fixed #2075-container series. No NFT authority is needed.
// Defaults to one READ-ONLY inspection. Signing requires the explicit --execute
// switch, an expected deployed runtime hash, and a dedicated funded keeper key.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, getAddress, keccak256, parseUnits } from "ethers";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ABI = JSON.parse(readFileSync(path.join(ROOT, "outputs/bem-raffle-2075/BemContainerRaffleBSC.abi.json"), "utf8"));
const S = { Unstarted: 0, Funding: 1, Locked: 2, Requested: 3, Ready: 4, Settled: 5, Refunding: 6 };
const json = (x) => JSON.stringify(x, (_k, v) => typeof v === "bigint" ? v.toString() : v);

export function decideKeeperAction(snapshot) {
  const { authorized, currentRoundId, current, previous, now, nextRoundOpensAt, timing } = snapshot;
  const idle = (reason, extra = {}) => ({ action: "wait", reason, ...extra });
  if (!authorized) return idle("2075 container has not authorized this series");
  const processingPrevious = current.status === S.Unstarted && currentRoundId > 1n
    && previous && ![S.Settled, S.Refunding].includes(previous.status);
  const round = processingPrevious ? previous : current;
  const roundId = processingPrevious ? currentRoundId - 1n : currentRoundId;
  if (round.status === S.Requested) return idle("Awaiting the ORIGINAL VRF request; never cancel or reroll", {
    roundId, targetOverdue: !!timing?.targetDrawBy && now > timing.targetDrawBy
  });
  if (round.status === S.Ready) {
    if (!timing?.scheduledDrawAt) return idle("Missing draw schedule; refusing to guess", { roundId });
    if (now < timing.scheduledDrawAt) return idle("Waiting for the VRF-derived draw time", { roundId, dueAt: timing.scheduledDrawAt });
    return { action: "settle", roundId, args: [roundId], targetOverdue: now > timing.targetDrawBy };
  }
  if (round.status === S.Funding) {
    if (now >= round.fundingDeadline) return { action: "openRefunds", roundId, args: [roundId] };
    return idle("Waiting for 100 BEM; the final purchase requests VRF atomically", { roundId });
  }
  if (current.status === S.Unstarted && (!previous || [S.Settled, S.Refunding].includes(previous.status))) {
    if (now < nextRoundOpensAt) return idle("60-second cooldown", { roundId: currentRoundId, dueAt: nextRoundOpensAt });
    return { action: "openNextRound", roundId: currentRoundId, args: [] };
  }
  // A persistent Locked state is impossible for this variant: request failure
  // reverts the final purchase. Do not silently apply a different variant's rules.
  return idle("Unexpected state; inspect the onchain records", { roundId, status: round.status });
}

function normalizeRound(r) {
  return { status: Number(r.status), fundingDeadline: r.fundingDeadline, requestId: r.requestId };
}

export async function readKeeperSnapshot(provider, game) {
  const block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("Missing block");
  const opts = { blockTag: block.number };
  const [authorized, currentRoundId, nextRoundOpensAt] = await Promise.all([
    game.seriesAuthorized(opts), game.currentRoundId(opts), game.nextRoundOpensAt(opts)
  ]);
  const [currentRaw, previousRaw] = await Promise.all([
    game.rounds(currentRoundId, opts), currentRoundId > 1n ? game.rounds(currentRoundId - 1n, opts) : null
  ]);
  const current = normalizeRound(currentRaw), previous = previousRaw ? normalizeRound(previousRaw) : null;
  const timingId = current.status === S.Unstarted && previous && ![S.Settled, S.Refunding].includes(previous.status)
    ? currentRoundId - 1n : currentRoundId;
  const t = await game.drawTiming(timingId, opts);
  const sameBlock = await provider.getBlock(block.number);
  if (sameBlock?.hash !== block.hash) throw new Error("Snapshot reorganized");
  return { blockNumber: block.number, blockHash: block.hash, now: BigInt(block.timestamp), authorized,
    currentRoundId, current, previous, nextRoundOpensAt,
    timing: { lockedAt: t.lockedAt, targetDrawBy: t.targetDrawBy, scheduledDrawAt: t.scheduledDrawAt, settledAt: t.settledAt } };
}

async function main() {
  const options = { execute: false, watch: false, intervalMs: 2000, maxGasPriceGwei: "1" };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--execute") options.execute = true;
    else if (argv[i] === "--watch") options.watch = true;
    else if (["--rpc", "--address", "--expected-code-hash", "--interval-ms", "--max-gas-price-gwei"].includes(argv[i]) && argv[i + 1]) {
      const key = { "--rpc": "rpc", "--address": "address", "--expected-code-hash": "expectedHash",
        "--interval-ms": "intervalMs", "--max-gas-price-gwei": "maxGasPriceGwei" }[argv[i]];
      options[key] = argv[++i];
    } else throw new Error("Invalid arguments");
  }
  const rpcUrl = options.rpc || process.env.BEM_RAFFLE_RPC;
  const address = getAddress(options.address || process.env.BEM_RAFFLE_ADDRESS || "");
  if (!rpcUrl) throw new Error("Set BEM_RAFFLE_RPC or --rpc");
  options.intervalMs = Number(options.intervalMs);
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1000 || options.intervalMs > 60_000) throw new Error("Invalid interval");
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    if ((await provider.getNetwork()).chainId !== 56n) throw new Error("Expected BSC mainnet chain ID 56");
    const code = await provider.getCode(address);
    if (code === "0x") throw new Error("Game has no deployed code");
    const hash = keccak256(code);
    if (options.execute && (!/^0x[0-9a-fA-F]{64}$/.test(options.expectedHash || "") || hash !== options.expectedHash.toLowerCase())) {
      throw new Error("Execution requires the independently verified deployed --expected-code-hash");
    }
    let game = new Contract(address, ABI, provider);
    const [container, circuitId, token, price, pool, cooldown, target] = await Promise.all([
      game.CONTAINER(), game.CIRCUIT_ID(), game.bem(), game.TICKET_PRICE(), game.ROUND_POOL(), game.NEXT_ROUND_DELAY(), game.DRAW_TARGET_SECONDS()
    ]);
    if (container.toLowerCase() !== "0x358be84b95224d228f3a61964fa3c9fb61d7b646" || circuitId !== 2075n
      || token.toLowerCase() !== "0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a" || price !== 1_000_000n
      || pool !== 10_000_000_000n || cooldown !== 60n || target !== 60n) throw new Error("Unexpected game configuration");
    if (options.execute) {
      if (!process.env.BEM_KEEPER_PRIVATE_KEY) throw new Error("Missing dedicated BEM_KEEPER_PRIVATE_KEY");
      let signer;
      try { signer = new Wallet(process.env.BEM_KEEPER_PRIVATE_KEY, provider); }
      catch { throw new Error("Invalid keeper key configuration"); }
      game = game.connect(signer);
    }
    const maxGasPrice = parseUnits(options.maxGasPriceGwei, "gwei");
    if (maxGasPrice <= 0n) throw new Error("Invalid gas price cap");
    console.log(json({ mode: options.execute ? "execute-public-keeper-actions" : "read-only", address, runtimeCodeHash: hash }));
    let pendingHash = null, lastReport = "", broadcastNeedsReview = false;
    do {
      try {
        if (pendingHash) {
          const receipt = await provider.getTransactionReceipt(pendingHash);
          if (receipt) {
            console.log(json({ transactionHash: pendingHash, status: receipt.status, blockNumber: receipt.blockNumber }));
            pendingHash = null;
          }
        }
        const snapshot = await readKeeperSnapshot(provider, game);
        const plan = decideKeeperAction(snapshot);
        const rendered = json(plan);
        if (rendered !== lastReport) { console.log(json({ observedBlock: snapshot.blockNumber, ...plan })); lastReport = rendered; }
        if (options.execute && !pendingHash && !broadcastNeedsReview && plan.action !== "wait") {
          // Every allowed action is public and has its own contract state checks.
          const method = game.getFunction(plan.action);
          await method.staticCall(...plan.args);
          const [estimated, fees] = await Promise.all([method.estimateGas(...plan.args), provider.getFeeData()]);
          const gasLimit = estimated * 120n / 100n + 20_000n;
          if (gasLimit > 4_000_000n || !fees.gasPrice || fees.gasPrice > maxGasPrice) {
            console.log(json({ action: "fee-cap-wait", gasLimit, gasPrice: fees.gasPrice }));
          } else {
            let tx;
            try { tx = await method(...plan.args, { value: 0, gasLimit, gasPrice: fees.gasPrice }); }
            catch (error) {
              // A network error may occur AFTER broadcast. Without a returned
              // hash, do not blindly send another transaction from this process.
              broadcastNeedsReview = true;
              console.error(json({ broadcastStatus: "uncertain", furtherBroadcastsPaused: true,
                nextStep: "Inspect this keeper wallet's pending nonce/transactions before restarting." }));
              throw error;
            }
            pendingHash = tx.hash;
            console.log(json({ submitted: plan.action, roundId: plan.roundId, transactionHash: tx.hash }));
          }
        }
      } catch (error) {
        // RPC URLs and signer configuration can be sensitive: no raw error dump.
        console.error(json({ keeperError: error.code || error.name || "Error", retryOnNextPoll: options.watch }));
        if (!options.watch) process.exitCode = 1;
      }
      if (options.watch && !stopped) await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    } while (options.watch && !stopped);
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop); provider.destroy();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(json({ startupError: error.code || error.name || "Error", message: "Keeper not started; check the RPC, game address, verified code hash, and local key configuration." })); process.exitCode = 1; });
}
