import { describe, it, expect, vi, beforeEach } from "vitest";
import { migrateV2ToV3, loadAccounts, type AccountStorage } from "./storage";
import { promises as fs } from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      unlink: vi.fn(),
    },
  };
});

describe("Storage Migration", () => {
  const now = Date.now();
  const future = now + 100000;
  const past = now - 100000;

  describe("migrateV2ToV3", () => {
    it("converts gemini rate limits to gemini-antigravity", () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: "r1",
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      };

      const v3 = migrateV2ToV3(v2);

      expect(v3.version).toBe(3);
      const account = v3.accounts[0];
      if (!account) throw new Error("Account not found");
      
      expect(account.rateLimitResetTimes).toEqual({
        "gemini-antigravity": future,
      });
      expect(account.rateLimitResetTimes?.["gemini-cli"]).toBeUndefined();
    });

    it("preserves claude rate limits", () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: "r1",
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: future,
            },
          },
        ],
        activeIndex: 0,
      };

      const v3 = migrateV2ToV3(v2);
      const account = v3.accounts[0];
      if (!account) throw new Error("Account not found");

      expect(account.rateLimitResetTimes).toEqual({
        claude: future,
      });
    });

    it("handles mixed rate limits correctly", () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: "r1",
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: future,
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      };

      const v3 = migrateV2ToV3(v2);
      const account = v3.accounts[0];
      if (!account) throw new Error("Account not found");

      expect(account.rateLimitResetTimes).toEqual({
        claude: future,
        "gemini-antigravity": future,
      });
    });

    it("filters out expired rate limits", () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: "r1",
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: past,
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      };

      const v3 = migrateV2ToV3(v2);
      const account = v3.accounts[0];
      if (!account) throw new Error("Account not found");

      expect(account.rateLimitResetTimes).toEqual({
        "gemini-antigravity": future,
      });
      expect(account.rateLimitResetTimes?.claude).toBeUndefined();
    });

    it("removes rateLimitResetTimes object if all keys are expired", () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: "r1",
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: past,
              gemini: past,
            },
          },
        ],
        activeIndex: 0,
      };

      const v3 = migrateV2ToV3(v2);
      const account = v3.accounts[0];
      if (!account) throw new Error("Account not found");

      expect(account.rateLimitResetTimes).toBeUndefined();
    });
  });

  describe("loadAccounts migration integration", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("migrates V2 storage on load and persists V3", async () => {
      const v2Data = {
        version: 2,
        accounts: [
          {
            refreshToken: "r1",
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(v2Data));
      
      const result = await loadAccounts();

      expect(result).not.toBeNull();
      expect(result?.version).toBe(3);
      
      const account = result?.accounts[0];
      if (!account) throw new Error("Account not found");
      
      expect(account.rateLimitResetTimes).toEqual({
        "gemini-antigravity": future,
      });

      expect(fs.writeFile).toHaveBeenCalled();
      const saveCall = vi.mocked(fs.writeFile).mock.calls[0];
      if (!saveCall) throw new Error("saveAccounts was not called");
      
      const savedContent = JSON.parse(saveCall[1] as string);
      expect(savedContent.version).toBe(3);
      expect(savedContent.accounts[0].rateLimitResetTimes).toEqual({
        "gemini-antigravity": future,
      });
    });
  });
});
