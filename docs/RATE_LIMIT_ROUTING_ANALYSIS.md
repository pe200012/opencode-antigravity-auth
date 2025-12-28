# Rate Limit & Multi-Account Routing Analysis

> Investigation of false alarms and routing inefficiencies in the current implementation.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture](#current-architecture)
3. [**CRITICAL: Issue #0 - Race Conditions in Concurrent Requests**](#issue-0-race-conditions)
4. [Issue #1: Contradictory Logic Between Account Selection and Quota Check](#issue-1-contradictory-logic)
5. [Issue #2: Dead Code - getAvailableHeaderStyle()](#issue-2-dead-code)
6. [Issue #3: Non-429 Errors Marked as Rate Limits (False Alarms)](#issue-3-non-429-false-alarms)
7. [Issue #4: No Quota Fallback Within Same Account](#issue-4-no-quota-fallback)
8. [Issue #5: No Distinction Between Quota Types in Toasts](#issue-5-toast-distinction)
9. [Issue #6: Explicit Model Suffix Should Lock Quota](#issue-6-explicit-suffix)
10. [Flow Diagrams](#flow-diagrams)
11. [Proposed Changes](#proposed-changes)
12. [Implementation Plan](#implementation-plan)

---

## Executive Summary

The current rate limit and multi-account routing logic has several issues causing:

1. **🔴 CRITICAL: Race conditions** - Concurrent subagent requests cause state corruption
2. **False alarm toasts** - Non-429 errors (auth failures, network issues) trigger "rate limited" messages
3. **Inefficient account rotation** - Accounts are switched when their alternate quota pool is still available
4. **Dead code** - `getAvailableHeaderStyle()` exists but is never used
5. **Confusing UX** - No distinction between quota exhaustion vs account switch vs auth errors

### Impact

| Issue | Severity | User Impact |
|-------|----------|-------------|
| **Race conditions (subagents)** | **CRITICAL** | Rate limits appear/disappear randomly, wrong quotas marked, state corruption |
| Non-429 false alarms | High | Confusing "rate limited" messages when quotas are fine |
| No quota fallback | High | Accounts exhausted 2x faster than necessary for Gemini |
| Hardcoded "antigravity" quota | Medium | Wrong quota marked for gemini-cli requests |
| Missing toast distinctions | Low | User confusion about what's happening |

### Context: Subagent Usage Pattern

This plugin is heavily used with [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) which spawns multiple subagents (explore, librarian, oracle, etc.) that make **concurrent API requests**. The current architecture assumes sequential request processing, which causes race conditions when multiple subagents fire simultaneously.

---

## Current Architecture

### Quota Pools

```
┌─────────────────────────────────────────────────────────────────┐
│                        QUOTA POOLS                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Claude Family:                                                  │
│    └─ "claude" quota (Antigravity only)                         │
│                                                                  │
│  Gemini Family:                                                  │
│    ├─ "gemini-antigravity" quota (via Antigravity endpoint)     │
│    └─ "gemini-cli" quota (via Gemini CLI endpoint)              │
│                                                                  │
│  Per Account:                                                    │
│    rateLimitResetTimes: {                                        │
│      "claude"?: number,           // Reset timestamp             │
│      "gemini-antigravity"?: number,                              │
│      "gemini-cli"?: number                                       │
│    }                                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Request Flow Overview

```
Request → getModelFamily() → getCurrentOrNextForFamily() → getHeaderStyle() 
        → isRateLimitedForHeaderStyle() → Make Request → Handle Response
```

---

## 🔴 CRITICAL: Issue #0 - Race Conditions {#issue-0-race-conditions}

### The Architecture Problem

The plugin uses **shared mutable state** without any synchronization, causing race conditions when subagents make concurrent requests.

```
┌─────────────────────────────────────────────────────────────────┐
│  CURRENT ARCHITECTURE (RACE CONDITION)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  loader() called ONCE at plugin init                             │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ accountManager = AccountManager │  ← SINGLE INSTANCE         │
│  │   .loadFromDisk()               │    shared by ALL requests  │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  return { fetch: async (input, init) => { ... } }               │
│                    ↑                                             │
│                    └── Closure captures accountManager           │
│                                                                  │
│  ═══════════════════════════════════════════════════════════════│
│                                                                  │
│  MODULE-LEVEL SHARED STATE (NO SYNCHRONIZATION):                │
│                                                                  │
│  const rateLimitStateByAccount = new Map<...>()  // consecutive │
│  const accountFailureState = new Map<...>()      // failures    │
│  const emptyResponseAttempts = new Map<...>()    // empty resp  │
│                                                                  │
│  ═══════════════════════════════════════════════════════════════│
│                                                                  │
│  CONCURRENT REQUESTS (from subagents):                          │
│                                                                  │
│   Main Agent ───┐                                                │
│   Explore ──────┼──► ALL share same accountManager              │
│   Librarian ────┤    ALL share same module-level Maps           │
│   Oracle ───────┘    NO locking or synchronization              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Race Condition #1: Your "Rate limit popup for 1-2 calls only" Bug

This explains the weird behavior where rate limit toasts appear briefly then disappear:

```
┌─────────────────────────────────────────────────────────────────┐
│  RACE: "Rate limit popup for 1-2 calls only"                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Time   Subagent 1          Subagent 2          Subagent 3      │
│  ────   ──────────          ──────────          ──────────      │
│                                                                  │
│  T0     getCurrentOrNext()  getCurrentOrNext()  getCurrentOrNext│
│         → Account 1         → Account 1         → Account 1     │
│         (ALL select SAME    (no rate limit)     (no rate limit) │
│          account!)                                               │
│                                                                  │
│  T1     fetch() starts      fetch() starts      fetch() starts  │
│         (all in flight      (all in flight      (all in flight  │
│          concurrently)       concurrently)       concurrently)  │
│                                                                  │
│  T2     ← 429 received!                                         │
│         markRateLimited()                                        │
│         Toast: "Rate                                             │
│          limited..."                                             │
│                                                                  │
│  T3                         ← 200 OK!           ← 200 OK!       │
│                             resetRateLimitState resetRateLimit  │
│                             (CLEARS the rate    (CLEARS again!) │
│                              limit set by #1!)                   │
│                                                                  │
│  T4     Sees rate limit                                         │
│         CLEARED by other                                         │
│         requests!                                                │
│         (confusion!)                                             │
│                                                                  │
│  RESULT: Rate limit toast appeared, then state was cleared      │
│          by concurrent success responses!                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Race Condition #2: "Gemini CLI rate limit on Antigravity model"

Cross-family contamination when concurrent requests use different models:

```
┌─────────────────────────────────────────────────────────────────┐
│  RACE: "Gemini CLI rate limit on Antigravity model"             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Time   Subagent 1 (Claude)      Subagent 2 (Gemini)            │
│  ────   ───────────────────      ───────────────────            │
│                                                                  │
│  T0     getCurrentOrNext()       getCurrentOrNext()             │
│         family="claude"          family="gemini"                │
│         → Account 1              → Account 1                    │
│                                                                  │
│  T1     Token refresh fails                                     │
│         trackAccountFailure()                                   │
│         failures = 5                                             │
│         markRateLimited(                                         │
│           account1, 30s,                                         │
│           "gemini",  ← WRONG                                    │
│           "antigravity")  FAMILY!                               │
│                                                                  │
│  T2                              Checks isRateLimited           │
│                                  ForHeaderStyle()               │
│                                  Sees "gemini-antigravity"      │
│                                  is marked (by Claude req!)     │
│                                  Toast: "Rate limited           │
│                                  on Antigravity quota"          │
│                                  ← FALSE! It's a Claude         │
│                                     auth error!                  │
│                                                                  │
│  RESULT: Gemini request sees rate limit caused by               │
│          unrelated Claude auth failure                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Race Condition #3: Consecutive Counter Inflation

When multiple concurrent requests all hit 429, the counter is inflated:

```
┌─────────────────────────────────────────────────────────────────┐
│  RACE: Consecutive counter inflation                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  3 concurrent requests all hit 429 at T=0:                      │
│                                                                  │
│  Expected: consecutive429 = 1 (same rate limit event)           │
│                                                                  │
│  Actual:                                                         │
│    Request 1: getRateLimitBackoff() → consecutive429 = 1        │
│    Request 2: getRateLimitBackoff() → consecutive429 = 2        │
│    Request 3: getRateLimitBackoff() → consecutive429 = 3        │
│                                                                  │
│  Result:                                                         │
│    Backoff calculated as 2^3 = 8x instead of 2^1 = 2x           │
│    Wait time inflated by 4x!                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Race Condition #4: Account Selection Stampede

All concurrent requests select the same account, then all hit rate limit together:

```
┌─────────────────────────────────────────────────────────────────┐
│  RACE: Account selection stampede                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  State: Account 1 at 95% quota usage                            │
│         Account 2 at 0% quota usage                             │
│                                                                  │
│  5 subagents call getCurrentOrNextForFamily() simultaneously:   │
│                                                                  │
│    Subagent 1 → Account 1 (not rate limited yet)                │
│    Subagent 2 → Account 1 (not rate limited yet)                │
│    Subagent 3 → Account 1 (not rate limited yet)                │
│    Subagent 4 → Account 1 (not rate limited yet)                │
│    Subagent 5 → Account 1 (not rate limited yet)                │
│                                                                  │
│  All 5 requests hit Account 1, which was at 95%:                │
│    - 4 requests succeed (exhaust quota)                         │
│    - 1 request gets 429                                         │
│                                                                  │
│  Expected: Load balance across accounts                         │
│  Actual: Stampede on single account                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### The Specific Code Issues

**Issue A: No Request Isolation**
```typescript
// plugin.ts:613 - Single instance for ALL requests
const accountManager = await AccountManager.loadFromDisk(auth);

// plugin.ts:657 - fetch() closure captures this single instance
return {
  async fetch(input, init) {
    // All concurrent requests share accountManager
    const account = accountManager.getCurrentOrNextForFamily(family);
    // ...
  }
}
```

**Issue B: Module-Level State Without Locking**
```typescript
// plugin.ts:422-443 - Shared across ALL requests
const rateLimitStateByAccount = new Map<number, {...}>();
const accountFailureState = new Map<number, {...}>();

// getRateLimitBackoff() reads AND writes without synchronization
function getRateLimitBackoff(accountIndex, serverRetryMs) {
  const previous = rateLimitStateByAccount.get(accountIndex);  // READ
  // ... concurrent requests can interleave here ...
  rateLimitStateByAccount.set(accountIndex, {...});  // WRITE
}
```

**Issue C: Success Clears Rate Limit Set by Other Request**
```typescript
// plugin.ts:1146-1147 - On success, clears rate limit for account
resetRateLimitState(account.index);
resetAccountFailureState(account.index);

// But another concurrent request might have just set this!
```

### Proposed Solutions for Concurrency

| Approach | Complexity | Description |
|----------|------------|-------------|
| **Request-scoped snapshots** | Low | Copy account state at request start, don't clear other requests' state |
| **Per-request rate limit tracking** | Medium | Track 429s per request ID, not per account |
| **Mutex/lock for state updates** | Medium | Synchronize access to shared Maps |
| **Request queuing per account** | High | Serialize requests to same account |
| **Optimistic locking** | Medium | Version numbers on state, retry on conflict |

**Recommended: Request-scoped snapshots + per-request tracking**

```typescript
// Each request gets its own "view" of rate limit state
// Success in request A doesn't clear rate limit set by request B
// 429 in request A only affects request A's retry logic
```

---

## Issue #1: Contradictory Logic {#issue-1-contradictory-logic}

### The Problem

Account selection and quota checking use **contradictory logic**:

**Account Selection (Correct - AND logic):**
```typescript
// accounts.ts:44-50
function isRateLimitedForFamily(account, family): boolean {
  if (family === "claude") return isRateLimitedForQuotaKey(account, "claude");
  // Gemini: BOTH quotas must be exhausted to consider account rate-limited
  return isRateLimitedForQuotaKey(account, "gemini-antigravity") && 
         isRateLimitedForQuotaKey(account, "gemini-cli");
}

// accounts.ts:201-216
getCurrentOrNextForFamily(family): ManagedAccount | null {
  if (!isRateLimitedForFamily(current, family)) {
    return current;  // Returns account if ANY quota available ✓
  }
}
```

**Quota Check (Buggy - immediately switches):**
```typescript
// plugin.ts:978-980
if (accountManager.isRateLimitedForHeaderStyle(account, family, headerStyle)) {
  shouldSwitchAccount = true;  // Switches on SINGLE quota exhaustion! ✗
}
```

### Example Scenario

```
State:
  Account 1: gemini-cli EXHAUSTED, gemini-antigravity AVAILABLE
  Account 2: Both quotas AVAILABLE

Request: gemini-3-flash (default: gemini-cli quota)

Current Flow:
  1. getCurrentOrNextForFamily("gemini") → Account 1 ✓
     (Correct: Account 1 has antigravity available)
  
  2. getHeaderStyleFromUrl() → "gemini-cli"
  
  3. isRateLimitedForHeaderStyle(account1, "gemini", "gemini-cli") → TRUE
  
  4. shouldSwitchAccount = true ✗
     (BUG: Doesn't try Account 1's antigravity quota!)
  
  5. Switches to Account 2 unnecessarily
     Account 1's antigravity quota is WASTED
```

---

## Issue #2: Dead Code {#issue-2-dead-code}

### The Method That Should Be Used

```typescript
// accounts.ts:249-261 - EXISTS but NEVER CALLED
getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily): HeaderStyle | null {
  clearExpiredRateLimits(account);
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude") ? null : "antigravity";
  }
  // Try antigravity first, then gemini-cli
  if (!isRateLimitedForQuotaKey(account, "gemini-antigravity")) {
    return "antigravity";
  }
  if (!isRateLimitedForQuotaKey(account, "gemini-cli")) {
    return "gemini-cli";
  }
  return null;
}
```

This is **exactly** what we need for quota fallback, but it's never used in `plugin.ts`.

---

## Issue #3: Non-429 False Alarms {#issue-3-non-429-false-alarms}

### The Mechanism

```typescript
// plugin.ts:443-467
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 30_000;      // 30 seconds
const FAILURE_STATE_RESET_MS = 120_000;  // 2 minutes

function trackAccountFailure(accountIndex: number): { 
  failures: number; 
  shouldCooldown: boolean; 
  cooldownMs: number 
} {
  // After 5 consecutive failures → shouldCooldown = true
}
```

### Call Sites (4 Locations)

| Location | Trigger | Error Type | Quota Marked | Correct? |
|----------|---------|------------|--------------|----------|
| Line 812-816 | `refreshAccessToken()` returns `null` | Auth failure | `"antigravity"` (hardcoded) | ❌ |
| Line 859-864 | `refreshAccessToken()` throws | Auth error | `"antigravity"` (hardcoded) | ❌ |
| Line 883-888 | `ensureProjectContext()` throws | Project error | `"antigravity"` (hardcoded) | ❌ |
| Line 1293-1298 | `fetch()` throws | Network error | `headerStyle` (dynamic) | ❌ |

### Why This Is Wrong

**These are NOT rate limits!** They're:
- Network failures
- Auth token issues  
- Project configuration errors

Calling `markRateLimited()` for these causes:
1. False "rate limited" state
2. Incorrect toast messages
3. Unnecessary account switches
4. Wrong retry timing

### The Cascading Problem

```
┌─────────────────────────────────────────────────────────────────┐
│  FALSE ALARM CHAIN                                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Network hiccup during token refresh                             │
│       ↓                                                          │
│  5 consecutive failures (within 2 min window)                    │
│       ↓                                                          │
│  markRateLimited(account1, 30s, "gemini", "antigravity")        │
│       ↓                                                          │
│  account1.rateLimitResetTimes["gemini-antigravity"] = now + 30s │
│       ↓                                                          │
│  Next request checks isRateLimitedForHeaderStyle()               │
│       ↓ returns TRUE                                             │
│  shouldSwitchAccount = true                                      │
│       ↓                                                          │
│  Toast: "Rate limited on Antigravity quota"  ← FALSE!            │
│       ↓                                                          │
│  Switch to Account 2 (might also have token issues)              │
│       ↓                                                          │
│  Same cycle repeats for Account 2...                             │
│       ↓                                                          │
│  ALL accounts marked as "rate limited"                           │
│       ↓                                                          │
│  Toast: "All 3 account(s) rate-limited. Waiting 30s..."         │
│       ↓                                                          │
│  COMPLETE FALSE ALARM - quotas are fine!                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Why 3 of 4 Call Sites Hardcode "antigravity"

```typescript
// Lines 815, 862, 886 - all hardcode "antigravity"
accountManager.markRateLimited(account, cooldownMs, family, "antigravity");
```

The `headerStyle` variable isn't defined at these points (determined AFTER token refresh succeeds). The original author picked "antigravity" arbitrarily.

**Result:** Even when using gemini-cli quota, a token refresh failure marks the antigravity quota as exhausted. Complete mismatch.

---

## Issue #4: No Quota Fallback {#issue-4-no-quota-fallback}

### Current Behavior

When preferred quota is exhausted:
1. Immediately set `shouldSwitchAccount = true`
2. Switch to next account
3. **Never try the other quota pool on current account**

### Expected Behavior (with opt-in config)

When preferred quota is exhausted:
1. Check if alternate quota is available on current account
2. If available: use it, show toast "Switched to [alternate] quota"
3. If not available: then switch accounts

### Impact

With current logic, accounts are exhausted **2x faster** than necessary for Gemini models (which have 2 quota pools).

---

## Issue #5: Toast Distinction {#issue-5-toast-distinction}

### Current Toasts (All Similar)

```
"Rate limited on Antigravity quota for account@email.com. Switching account..."
"Rate limited on Gemini CLI quota for account@email.com. Switching account..."
"All N account(s) rate-limited for gemini. Waiting Xs..."
```

### Missing Distinctions

| Scenario | Current Toast | Should Be |
|----------|---------------|-----------|
| Quota fallback within account | N/A (doesn't happen) | "Gemini CLI quota exhausted, using Antigravity quota" |
| Both quotas exhausted | "Rate limited..." | "Both quotas exhausted for Account 1, switching..." |
| Auth/network error | "Rate limited..." | "Account temporarily unavailable (auth error)..." |
| All accounts auth failure | "All N rate-limited..." | "All accounts experiencing auth issues..." |

---

## Issue #6: Explicit Suffix {#issue-6-explicit-suffix}

### Current Model Resolution

```typescript
// model-resolver.ts
const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);  // "antigravity-" prefix
const quotaPreference = isAntigravity || isAntigravityOnly ? "antigravity" : "gemini-cli";
```

### The Problem

No way to distinguish:
- User explicitly requested `antigravity-gemini-3-flash` (wants antigravity specifically)
- Default quota selection (can fall back to other quota)

### Expected Behavior

| Request | Quota Exhausted | Expected Action |
|---------|-----------------|-----------------|
| `gemini-3-flash` (default) | gemini-cli | Try antigravity on same account (if fallback enabled) |
| `antigravity-gemini-3-flash` (explicit) | antigravity | Switch to next account (respect user choice) |

---

## Flow Diagrams

### Current Flow (Buggy)

```
┌─────────────────────────────────────────────────────────────────┐
│  CURRENT REQUEST FLOW                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Request: gemini-3-flash (default: gemini-cli quota)            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ getModelFamilyFromUrl()         │                            │
│  │ → "gemini"                      │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ getCurrentOrNextForFamily()     │                            │
│  │ Uses AND logic (correct)        │                            │
│  │ → Account 1                     │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ getHeaderStyleFromUrl()         │                            │
│  │ → "gemini-cli"                  │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ isRateLimitedForHeaderStyle()   │                            │
│  │ gemini-cli exhausted?           │                            │
│  │                                 │                            │
│  │ YES → shouldSwitchAccount=true  │ ← BUG: No fallback!        │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ Switch to Account 2             │                            │
│  │                                 │                            │
│  │ Account 1's antigravity quota   │                            │
│  │ is WASTED!                      │                            │
│  └─────────────────────────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Proposed Flow (With Opt-In Quota Fallback)

```
┌─────────────────────────────────────────────────────────────────┐
│  PROPOSED FLOW (quota_fallback: true)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Request: gemini-3-flash (default: gemini-cli quota)            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ getModelFamilyFromUrl()         │                            │
│  │ → "gemini"                      │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ getCurrentOrNextForFamily()     │                            │
│  │ → Account 1                     │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ preferredStyle = "gemini-cli"   │                            │
│  │ (from model suffix/default)     │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ isRateLimitedForHeaderStyle()   │                            │
│  │ gemini-cli exhausted? YES       │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ IF config.quota_fallback:       │ ← NEW LOGIC                │
│  │                                 │                            │
│  │   alt = getAvailableHeaderStyle │                            │
│  │   → "antigravity" (available!)  │                            │
│  │                                 │                            │
│  │   headerStyle = alt             │                            │
│  │   Toast: "CLI quota exhausted,  │                            │
│  │          using Antigravity"     │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ Make request with antigravity   │                            │
│  │ quota on Account 1              │ ← Uses available quota!    │
│  └─────────────────────────────────┘                            │
│                                                                  │
│  ════════════════════════════════════════════════════════════   │
│                                                                  │
│  IF alt is NULL (both quotas exhausted):                        │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ Toast: "Both quotas exhausted,  │                            │
│  │        switching to Account 2"  │                            │
│  │ shouldSwitchAccount = true      │                            │
│  └─────────────────────────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Proposed Flow (Explicit Quota Suffix)

```
┌─────────────────────────────────────────────────────────────────┐
│  PROPOSED FLOW (explicit: antigravity-gemini-3-flash)           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Request: antigravity-gemini-3-flash                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ resolveModelWithTier()          │                            │
│  │ → quotaPreference: "antigravity"│                            │
│  │ → explicitQuota: true  ← NEW    │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ isRateLimitedForHeaderStyle()   │                            │
│  │ antigravity exhausted? YES      │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ IF explicitQuota:               │                            │
│  │   NO fallback (respect user)    │                            │
│  │   shouldSwitchAccount = true    │                            │
│  │   Toast: "Antigravity quota     │                            │
│  │          exhausted, switching   │                            │
│  │          to next account"       │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ Switch to Account 2             │                            │
│  │ Use same quota (antigravity)    │                            │
│  └─────────────────────────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Proposed Flow (Non-429 Error Handling)

```
┌─────────────────────────────────────────────────────────────────┐
│  PROPOSED: SEPARATE FAILURE TRACKING                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Token refresh fails                                             │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ trackAccountFailure()           │                            │
│  │ → failures: 5                   │                            │
│  │ → shouldCooldown: true          │                            │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ CURRENT (buggy):                │                            │
│  │   markRateLimited(account, 30s, │                            │
│  │     "gemini", "antigravity")    │                            │
│  │   Toast: "Rate limited..."      │ ← FALSE ALARM              │
│  └─────────────────────────────────┘                            │
│                                                                  │
│  ════════════════════════════════════════════════════════════   │
│                                                                  │
│  ┌─────────────────────────────────┐                            │
│  │ PROPOSED (correct):             │                            │
│  │   markAccountCoolingDown(       │ ← Separate from quotas     │
│  │     account, 30s, reason)       │                            │
│  │   Toast: "Account temporarily   │                            │
│  │          unavailable (auth      │                            │
│  │          error), trying next"   │ ← Accurate message         │
│  └─────────────────────────────────┘                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────┐                            │
│  │ Account state:                  │                            │
│  │   rateLimitResetTimes: {}       │ ← Quotas NOT touched       │
│  │   coolingDownUntil: now + 30s   │ ← Separate field           │
│  │   cooldownReason: "auth_error"  │                            │
│  └─────────────────────────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Proposed Changes

### Summary Table

| Component | Current | Proposed |
|-----------|---------|----------|
| **Quota fallback** | None - switches account immediately | Opt-in `quota_fallback: true` tries other quota first |
| **Explicit suffix** | No distinction from default | Track `explicitQuota: true`, skip fallback |
| **Non-429 failures** | `markRateLimited()` with hardcoded "antigravity" | Separate `markAccountCoolingDown()` |
| **Toast messages** | "Rate limited on X quota" for ALL errors | Distinct messages for each scenario |
| **`getAvailableHeaderStyle()`** | Dead code, never called | Used for quota fallback logic |

### New Config Options

```yaml
# antigravity.yaml
quota_fallback: true  # Enable quota fallback within same account (default: false)
```

### New Account State

```typescript
interface ManagedAccount {
  // Existing
  rateLimitResetTimes: {
    claude?: number;
    "gemini-antigravity"?: number;
    "gemini-cli"?: number;
  };
  
  // NEW: Separate from quota rate limits
  coolingDownUntil?: number;
  cooldownReason?: "auth_error" | "network_error" | "project_error";
}
```

### New/Modified Methods

```typescript
// accounts.ts - NEW
markAccountCoolingDown(account: ManagedAccount, durationMs: number, reason: string): void;
isAccountCoolingDown(account: ManagedAccount): boolean;
clearAccountCooldown(account: ManagedAccount): void;

// accounts.ts - MODIFY
getCurrentOrNextForFamily(family): ManagedAccount | null {
  // Add check for coolingDownUntil in addition to rateLimitResetTimes
}
```

### Toast Message Improvements

| Scenario | New Toast |
|----------|-----------|
| Quota fallback | `"Gemini CLI quota exhausted, using Antigravity quota"` |
| Both quotas exhausted | `"Both quotas exhausted for [account], switching to next account"` |
| Auth/network cooldown | `"Account [email] temporarily unavailable ([reason]), trying next account"` |
| All accounts cooling down | `"All accounts experiencing issues. Waiting [X]s..."` |

---

## Implementation Plan

### Phase 0: Fix Race Conditions (CRITICAL - Must Do First)

Without fixing concurrency, all other fixes will have unpredictable behavior.

1. **Request-scoped rate limit snapshots**
   - Create `RateLimitSnapshot` that copies account state at request start
   - Each request works with its own snapshot, not shared state
   
2. **Isolate success/failure handling**
   - Success in Request A should NOT clear rate limit set by Request B
   - Only clear rate limits based on time expiry, not success events
   
3. **Per-request retry tracking**
   - Move `consecutive429` counter from module-level to request-level
   - Each request tracks its own retry attempts independently
   
4. **Account selection with reservation**
   - When selecting an account, temporarily "reserve" it
   - Prevents stampede where all concurrent requests pick same account
   - Or: Accept stampede but handle gracefully (don't over-penalize)

5. **Add tests for concurrent scenarios**
   - Multiple requests selecting same account
   - Mixed success/failure responses
   - Cross-family request interference

### Phase 1: Fix Non-429 False Alarms (High Priority)

1. Add `coolingDownUntil` and `cooldownReason` to `ManagedAccount`
2. Add `markAccountCoolingDown()`, `isAccountCoolingDown()`, `clearAccountCooldown()` methods
3. Modify `getCurrentOrNextForFamily()` to check cooldown state
4. Replace `markRateLimited()` calls at lines 815, 862, 886, 1296 with `markAccountCoolingDown()`
5. Update toast messages to reflect actual error type
6. Add tests for cooldown behavior

### Phase 2: Implement Quota Fallback (Medium Priority)

1. Add `quota_fallback` config option (default: false)
2. Add `explicitQuota` field to `ResolvedModel` type
3. Modify `resolveModelWithTier()` to detect explicit prefix
4. Modify plugin.ts quota check logic:
   - If preferred quota exhausted AND `quota_fallback` enabled AND NOT explicit:
     - Call `getAvailableHeaderStyle()` for alternate
     - Use alternate if available
     - Show fallback toast
   - Else: switch accounts as before
5. Add distinct toasts for quota fallback vs account switch
6. Add tests for fallback behavior

### Phase 3: Toast & UX Improvements (Low Priority)

1. Audit all toast messages for consistency
2. Add more context to toasts (account email, wait time, quota type)
3. Consider adding debug-level logging for all routing decisions

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/plugin/accounts.ts` | Add cooldown methods, modify `getCurrentOrNextForFamily()` |
| `src/plugin/storage.ts` | Add cooldown fields to storage types |
| `src/plugin/config/schema.ts` | Add `quota_fallback` config option |
| `src/plugin/transform/model-resolver.ts` | Add `explicitQuota` to return type |
| `src/plugin.ts` | Implement fallback logic, fix non-429 handling, update toasts |
| `src/plugin/accounts.test.ts` | Add tests for new behaviors |

---

## Questions for Review

1. **Config naming**: Is `quota_fallback: true` the right name? Alternatives:
   - `gemini_quota_fallback`
   - `auto_quota_fallback`
   - `fallback_to_alternate_quota`

2. **Cooldown visibility**: Should cooldown state be persisted to disk or memory-only?
   - Disk: Survives restarts but may cause confusion
   - Memory: Resets on restart, cleaner but less resilient

3. **Toast verbosity**: Current plan is verbose. Should there be a `quiet_mode` that suppresses fallback toasts?

4. **Fallback priority**: Current `getAvailableHeaderStyle()` tries antigravity first, then gemini-cli. Should this be configurable?
