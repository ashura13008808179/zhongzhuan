/**
 * Mid-request live billing: as billed tokens grow, charge
 * token-table cost × global rate immediately and shrink the reservation.
 */

export const LIVE_POLL_INTERVAL_MS = 500;

export function liveChargeDelta(prevCost, nextCost, rate) {
  const prev = Math.max(0, Number(prevCost) || 0);
  const next = Math.max(0, Number(nextCost) || 0);
  const mul = Number(rate);
  if (!(next > prev) || !Number.isFinite(mul) || mul <= 0) return 0;
  return (next - prev) * mul;
}

/** Customer charge = token-table cost × global rate. */
export function exactUserCharge(tokenCost, rate) {
  const cost = Math.max(0, Number(tokenCost) || 0);
  const mul = Number(rate);
  if (!Number.isFinite(mul) || mul <= 0) return 0;
  return cost * mul;
}

/**
 * Real-time target is the current token-table cost × rate.
 * Official actual_cost is recorded separately and does not set the charge.
 */
export function liveBillTarget(_actualCost, tokenFloorCost, rate) {
  return exactUserCharge(tokenFloorCost, rate);
}

export function applyLiveMoneyRefund(user, apiKeyRec, amount, unlimited = false) {
  const refund = Math.max(0, Number(amount) || 0);
  if (refund <= 0 || unlimited) return 0;
  user.balance = Math.max(0, (Number(user.balance) || 0) + refund);
  if (apiKeyRec) {
    apiKeyRec.spendUsed = Math.max(0, (Number(apiKeyRec.spendUsed) || 0) - refund);
  }
  return refund;
}

/**
 * Deduct `charge` from the user now. Shrink reservation so we do not double-hold.
 * reservation.amountReservation is the remaining prepaid hold for this request.
 */
export function applyLiveMoneyCharge(user, apiKeyRec, charge, reservation, unlimited = false) {
  const amount = Math.max(0, Number(charge) || 0);
  if (amount <= 0) return { broke: false, applied: 0 };
  let applied = amount;
  if (!unlimited) {
    const bal = Math.max(0, Number(user.balance) || 0);
    applied = Math.min(bal, amount);
    user.balance = Math.max(0, bal - applied);
    if (apiKeyRec && applied > 0) {
      apiKeyRec.spendUsed = (apiKeyRec.spendUsed || 0) + applied;
      if (apiKeyRec.spendLimit > 0) {
        apiKeyRec.spendUsed = Math.min(apiKeyRec.spendLimit, apiKeyRec.spendUsed);
      }
    }
  }
  const hold = Math.max(0, Number(reservation?.amountReservation) || 0);
  const shrink = Math.min(applied, hold);
  if (reservation) reservation.amountReservation = Math.max(0, hold - shrink);
  user.reservedBalance = Math.max(0, (user.reservedBalance || 0) - shrink);
  if (apiKeyRec) {
    apiKeyRec.reservedSpend = Math.max(0, (apiKeyRec.reservedSpend || 0) - shrink);
  }
  const broke = !unlimited && (Number(user.balance) || 0) <= 1e-8;
  return { broke, applied };
}

export function settleRemainder(totalCharge, alreadyCharged) {
  const total = Math.max(0, Number(totalCharge) || 0);
  const already = Math.max(0, Number(alreadyCharged) || 0);
  return Math.max(0, total - already);
}

/** Park leftover pre-auth as a pending hold until actual_cost arrives. Available balance stays reduced. */
export function parkPendingHold(user, apiKeyRec, hold) {
  const amount = Math.max(0, Number(hold) || 0);
  if (amount <= 0) return 0;
  user.pendingActualHold = (Number(user.pendingActualHold) || 0) + amount;
  if (apiKeyRec) apiKeyRec.pendingActualHold = (Number(apiKeyRec.pendingActualHold) || 0) + amount;
  return amount;
}

export function releasePendingHold(user, apiKeyRec, hold) {
  const amount = Math.max(0, Number(hold) || 0);
  user.pendingActualHold = Math.max(0, (Number(user.pendingActualHold) || 0) - amount);
  if (apiKeyRec) {
    apiKeyRec.pendingActualHold = Math.max(0, (Number(apiKeyRec.pendingActualHold) || 0) - amount);
  }
  return amount;
}
