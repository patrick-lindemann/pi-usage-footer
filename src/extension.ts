import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FooterConfig, loadConfig } from "./config/config.ts";
import { formatQuota, formatQuotaSummary, renderFooter } from "./footer.ts";
import { fetchUsage, resolveProvider } from "./providers/providers.ts";
import type { Snapshot } from "./usage.ts";

const refreshIntervalMs = 60_000;

/**
 * Registers the quota footer and refresh command with Pi.
 * @param pi Pi's API for session hooks, footer access and commands.
 * @returns Nothing. Quota fetching starts when the session starts.
 */
export function registerExtension(pi: ExtensionAPI): void {
  let config: FooterConfig;
  let requestRender = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const snapshots = new Map<string, Snapshot>();
  const pending = new Map<string, Promise<void>>();

  async function _refresh(ctx: ExtensionContext, force = false): Promise<void> {
    const provider = resolveProvider(ctx.model?.provider, config.endpoints);
    if (!provider) {
      return;
    }
    const current = pending.get(provider.cacheKey);
    if (current && !force) {
      return current;
    }
    const update = fetchUsage(provider, ctx)
      .then((snapshot) => {
        if (snapshot) {
          snapshots.set(provider.cacheKey, snapshot);
        }
      })
      .catch(() => {
        // An endpoint failure must not interrupt the model run or clear the last good result.
      });
    pending.set(provider.cacheKey, update);
    await update;
    if (pending.get(provider.cacheKey) === update) {
      pending.delete(provider.cacheKey);
    }
    requestRender();
  }

  function _installFooter(ctx: ExtensionContext): void {
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      return {
        dispose: footerData.onBranchChange(requestRender),
        invalidate() {},
        render(width) {
          const provider = resolveProvider(ctx.model?.provider, config.endpoints);
          const quota = provider
            ? formatQuota(
                snapshots.get(provider.cacheKey),
                config.windowOverrides.get(provider.cacheKey) ??
                  config.windowOverrides.get(provider.id) ??
                  config.windows,
                config.format,
                theme,
              )
            : undefined;
          return renderFooter(ctx, footerData, theme, width, pi.getThinkingLevel(), quota);
        },
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig();
    _installFooter(ctx);
    await _refresh(ctx);
    timer = setInterval(() => void _refresh(ctx), refreshIntervalMs);
    timer.unref();
  });
  pi.on("model_select", async (_event, ctx) => {
    _installFooter(ctx);
    await _refresh(ctx, true);
  });
  pi.on("agent_settled", (_event, ctx) => void _refresh(ctx));
  pi.on("session_shutdown", () => {
    if (timer) {
      clearInterval(timer);
    }
    timer = undefined;
    requestRender = () => {};
  });
  pi.registerCommand("usage-footer", {
    description: "Refresh and show subscription usage for the active provider",
    handler: async (_args, ctx) => {
      await _refresh(ctx, true);
      const provider = resolveProvider(ctx.model?.provider, config.endpoints);
      const snapshot = provider && snapshots.get(provider.cacheKey);
      if (!provider || !snapshot) {
        ctx.ui.notify("Usage is unavailable for the active provider.", "warning");
        return;
      }
      ctx.ui.notify(formatQuotaSummary(provider.name, snapshot), "info");
    },
  });
}
