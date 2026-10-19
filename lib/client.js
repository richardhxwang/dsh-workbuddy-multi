/**
 * dsh-workbuddy-multi — browser half (settings card + plugin config page).
 *
 * This is a DSH *client* bundle. The host does not import it: DSH serves it to the
 * browser, where it registers itself through the same module protocol
 * `dsh-workbuddy-connect` uses (`window.__ModuleLoader__.load({ id, factory })`,
 * with `react` / `react/jsx-runtime` resolved through the injected `require`).
 *
 * The wiring below is deliberately a copy of the upstream plugin's verified
 * pattern (`~/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect/lib/client.js`):
 *
 *   - `inject = ["slots", "locale", "remote", "remote.session"]`
 *   - `ctx.effect(() => ctx.locale.register(ns, { zh, en }), label)` for card copy
 *   - `ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({...}, Card))`
 *   - `ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({...}, Page))`
 *   - every contribution wrapped in `guardClientContribution`, so a slot-API
 *     breaking change degrades to one `console.error` instead of raising the red
 *     "Failed to load plugins" banner
 *   - host RPC as a plain `fetch()` against `/plugins/<bundle-name>/…` with
 *     `credentials: "same-origin"` (GET for reads, POST for writes)
 *
 * There is no bundler step and no JSX transform for this file, so the JSX runtime is
 * called directly (`jsx` / `jsxs`), exactly as the upstream *built* output does.
 *
 * The host action names and their parameter names are frozen by PLAN.md §3.2 and
 * confirmed with the host half; this half maps them 1:1 onto
 * `POST /plugins/dsh-workbuddy-multi/action` and never invents or renames an action.
 */
window.__ModuleLoader__.load({
	id: "dsh-workbuddy-multi",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		const Fragment = react.Fragment;

		//#region src/endpoints.js
		/**
		 * The bundle's package name. DSH dispatches `plugins.bundle.config` by the
		 * bundle's package name, so this has to spell exactly what the profile installs.
		 */
		const BUNDLE_NAME = "dsh-workbuddy-multi";

		/**
		 * The single base the host mounts both routes under. Kept as one constant so a
		 * rename is a one-line change here; the host half mounts exactly this prefix.
		 */
		const BUNDLE_BASE = `/plugins/${BUNDLE_NAME}`;

		/**
		 * Plugin-owned host endpoints, mirroring the upstream plugin's
		 * `/plugins/<bundle-name>/…` layout.
		 *
		 * Reads live on the GET route; anything that mutates pool state — including
		 * `refreshFromDesktop`, which spends an upstream request re-reading the
		 * desktop app's auth file — lives on the POST route. That split is inherited
		 * from upstream, which keeps its own "refresh models" write off its status GET.
		 */
		const STATUS_PATH = `${BUNDLE_BASE}/status`;
		const ACTION_PATH = `${BUNDLE_BASE}/action`;
		//#endregion

		//#region src/actions.js
		/**
		 * The host action names, frozen by PLAN.md §3.2. Keys and values are identical
		 * on purpose: the map is the single place this half could drift from the
		 * contract, and a typo here is visible at a glance.
		 */
		const ACTIONS = {
			select: "select",
			advance: "advance",
			setEnabled: "setEnabled",
			setLabel: "setLabel",
			remove: "remove",
			refreshFromDesktop: "refreshFromDesktop",
			importPaths: "importPaths",
			setPolicy: "setPolicy",
			loginStart: "loginStart",
			loginPoll: "loginPoll",
			loginCancel: "loginCancel",
			refreshAccount: "refreshAccount",
			setPinned: "setPinned",
			refreshCredits: "refreshCredits",
			setReasoningCache: "setReasoningCache",
			setCreditsChip: "setCreditsChip"
		};

		/**
		 * The two variants the login panel offers, in choice order.
		 *
		 * The keys are the frozen `variantKey` domain (`'cn' | 'ai'`), not route ids.
		 */
		/**
		 * 两个登录入口：国内版是微信扫码页，国际版是邮箱/第三方账号的手动登录页。
		 * 协议是同一个（state → authUrl → 轮询），只是页面形态不同，措辞按形态分。
		 */
		const LOGIN_VARIANTS = [
			{ key: "cn", labelKey: "loginVariantCn", hintKey: "loginScanHint", waitingKey: "loginWaiting" },
			{ key: "ai", labelKey: "loginVariantAi", hintKey: "loginManualHint", waitingKey: "loginWaitingManual" }
		];

		/**
		 * How often the login panel polls `loginPoll`, in milliseconds.
		 *
		 * The panel drives BOTH the countdown and the poll from one 1s interval and
		 * fires the poll on every second tick, so a waiting panel owns exactly one
		 * timer rather than a countdown timer plus a poll timer.
		 */
		const LOGIN_TICK_MS = 1000;
		const LOGIN_POLL_EVERY_TICKS = 2;

		/** Fallback session lifetime when the host does not report `expiresIn`. */
		const LOGIN_DEFAULT_EXPIRES_MS = 600000;

		/** The rotation policies the host accepts, in selector order. */
		const POLICIES = [
			{ id: "on-rate-limit", labelKey: "policyOnRateLimit", hintKey: "policyOnRateLimitHint" },
			{ id: "round-robin", labelKey: "policyRoundRobin", hintKey: "policyRoundRobinHint" },
			{ id: "manual", labelKey: "policyManual", hintKey: "policyManualHint" }
		];

		/**
		 * The two model-group layouts, in choice order.
		 *
		 * `merged` is the default: one model group per variant — the upstream
		 * `workbuddy` (domestic) and `workbuddy-ai` (international) routes — with this
		 * plugin rotating accounts inside that group. `per-account` gives every account
		 * its own group, for when a specific account must be picked by hand.
		 *
		 * The domestic and international variants stay separate in BOTH layouts:
		 * different route ids, different auth env vars, different active files, and the
		 * pool rejects a credential whose region does not match the variant.
		 *
		 * `on` is the boolean the host action `setPinned` expects; it is carried here so
		 * the two halves cannot disagree about which mode means what.
		 */
		const GROUP_MODES = [
			{ id: "merged", on: false, labelKey: "groupsMerged", hintKey: "groupsMergedHint" },
			{
				id: "per-account",
				on: true,
				labelKey: "groupsPerAccount",
				hintKey: "groupsPerAccountHint"
			}
		];

		/** Poll cadence while the card is open, in milliseconds. */
		const POLL_INTERVAL_MS = 15000;

		/**
		 * Poll cadence for the composer's credits chip, in milliseconds.
		 *
		 * Deliberately much slower than the card's. The host caches the credit
		 * aggregate for `ttlMs` (60s by default) and each recompute spends one billing
		 * GET per account, so polling the chip faster than the TTL cannot produce a new
		 * number — it can only spend requests. 60s matches the TTL, so the chip is
		 * never more than one TTL stale and never double-spends.
		 */
		const CREDITS_POLL_MS = 60000;

		/**
		 * TTL assumed when the host has not told us one (`status.credits.ttlMs` missing).
		 *
		 * Only used to decide whether a mount-time refresh could change anything; matches
		 * the host's documented 60s default so the two agree when it is absent.
		 */
		const CREDITS_TTL_FALLBACK_MS = 60000;
		//#endregion

		//#region src/status-shape.js
		/**
		 * Unwrap the host's POST/GET envelope when one is present.
		 *
		 * The action route answers `{ ok, result }` and the status route answers the
		 * document itself. Reading through this keeps the card working either way, so a
		 * host that wraps its read response does not turn every poll into a failed read.
		 */
		function unwrapEnvelope(value) {
			if (value !== null && typeof value === "object" && !Array.isArray(value) && value.ok === true && "result" in value) return value.result;
			return value;
		}

		/** The human-readable reason from a failed response envelope, when it carries one. */
		function envelopeError(value) {
			if (value !== null && typeof value === "object" && typeof value.error === "string" && value.error !== "") return value.error;
			return void 0;
		}

		/**
		 * Is this a status document this half can render?
		 *
		 * Follows the upstream card's two correctness rules:
		 *
		 *   - a non-document body (empty, `null`, an HTML error page) is a *failed
		 *     read*, not something to store and then dereference while rendering;
		 *   - a failed read never discards a document already on screen.
		 *
		 * Only the fields the render cannot survive without are required. The host
		 * legitimately omits fields a document does not have yet — an account with no
		 * cooldown has no `cooldownUntil`, not `cooldownUntil: null` — so this must not
		 * reject a sparse document.
		 */
		function isStatusDocument(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
			if (typeof value.policy !== "string") return false;
			if (!Array.isArray(value.variants)) return false;
			for (const variant of value.variants) {
				if (variant === null || typeof variant !== "object") return false;
				if (!Array.isArray(variant.accounts)) return false;
			}
			return true;
		}

		/** Coerce an optional array field to `[]` so the render never sees `undefined`. */
		function arrayOf(value) {
			return Array.isArray(value) ? value : [];
		}

		/** The cooldown record for one account, from the variant's `cooling` list. */
		function coolingFor(variant, uid) {
			for (const entry of arrayOf(variant.cooling)) {
				if (entry !== null && typeof entry === "object" && entry.uid === uid) return entry;
			}
			return void 0;
		}

		/**
		 * The epoch-ms instant an account is cooling until, or `undefined` when it is
		 * not cooling. The per-account `cooldownUntil` is authoritative; the variant's
		 * `cooling` list is the fallback for a document that only carries that side.
		 */
		function cooldownUntil(variant, account) {
			if (typeof account.cooldownUntil === "number") return account.cooldownUntil;
			const cooling = coolingFor(variant, account.uid);
			if (cooling !== void 0 && typeof cooling.until === "number") return cooling.until;
			return void 0;
		}
		//#endregion

		//#region src/format.js
		/** Interpolate `{name}` placeholders; a missing parameter keeps its placeholder. */
		function interpolate(template, params) {
			if (params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => {
				const value = params[name];
				return value === void 0 ? match : String(value);
			});
		}

		/** The first 8 characters of a uid — what the card shows to identify an account. */
		function shortUid(uid) {
			return typeof uid === "string" ? uid.slice(0, 8) : "";
		}

		/** Local `YYYY-MM-DD HH:mm`, or an em dash when there is no instant. */
		function formatInstant(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
			const date = new Date(ms);
			if (Number.isNaN(date.getTime())) return "—";
			const pad = (n) => String(n).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/** Local `HH:mm` — the compact form the cooldown badge shows. */
		function formatClock(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
			const date = new Date(ms);
			if (Number.isNaN(date.getTime())) return "—";
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/** `m:ss` remaining, floored at zero — the login panel's countdown. */
		function formatCountdown(ms) {
			const total = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
			return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
		}

		/**
		 * How much longer an instant is from now, in the coarsest honest unit.
		 *
		 * Returns `undefined` when there is no usable instant, so a caller can omit the
		 * whole line rather than render a meaningless "还剩 —". The unit is returned as a
		 * token (never a formatted string) so the caller picks the locale key: copy stays
		 * in the dictionaries, not in arithmetic.
		 */
		function remainingParts(ms, now) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return void 0;
			const left = ms - (typeof now === "number" ? now : Date.now());
			if (left <= 0) return { expired: true, ms: 0, unit: void 0, n: 0 };
			if (left < 60000) return { expired: false, ms: left, unit: "second", n: Math.floor(left / 1000) };
			if (left < 3600000) return { expired: false, ms: left, unit: "minute", n: Math.floor(left / 60000) };
			if (left < 86400000) return { expired: false, ms: left, unit: "hour", n: Math.floor(left / 3600000) };
			return { expired: false, ms: left, unit: "day", n: Math.floor(left / 86400000) };
		}

		/** Locale key per remaining-time unit, so no key is ever built at runtime. */
		const REMAINING_KEYS = {
			second: "expiresInSeconds",
			minute: "expiresInMinutes",
			hour: "expiresInHours",
			day: "expiresInDays"
		};

		/** Render `remainingParts` through `t`, or `undefined` when there is nothing to say. */
		function describeRemaining(ms, t, now) {
			const parts = remainingParts(ms, now);
			if (parts === void 0) return void 0;
			if (parts.expired) return t("expiresExpired");
			return t(REMAINING_KEYS[parts.unit], { n: parts.n });
		}

		/**
		 * Normalise the host's `loginStart` lifetime to milliseconds.
		 *
		 * The contract fixes the field name (`expiresIn`) but not its unit. Rather than
		 * guess, we separate the two plausible readings by magnitude: a login link lives
		 * for minutes, so anything at or below 100000 is seconds and anything above it is
		 * already milliseconds. Both readings of a 600-second link therefore normalise to
		 * the same deadline, and neither can produce a countdown of hours from a value
		 * that meant seconds. An unusable value falls back to the documented 600s window
		 * rather than to `NaN`, which would leave the panel with no countdown at all.
		 */
		function normalizeExpiresIn(value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return LOGIN_DEFAULT_EXPIRES_MS;
			return value <= 100000 ? value * 1000 : value;
		}

		/** The login `source` an account row shows as a badge. */
		const SOURCE_LABEL_KEYS = {
			desktop: "accountSourceDesktop",
			oauth: "accountSourceOauth",
			import: "accountSourceImport"
		};

		//#endregion

		//#region src/credits.js
		/**
		 * The merged group's credit total: the composer chip and the card's per-account
		 * breakdown.
		 *
		 * WHY THIS EXISTS AT ALL: upstream's own credit chip is a composer contribution
		 * (`id: "workbuddy-probe"`, `order: 10`) fed by *upstream's* status route, which
		 * answers for **the one credential currently in effect**. It has no concept of a
		 * pool, so it structurally cannot show a sum. We cannot change it (the companion
		 * never edits upstream) and must not hide it (that would be a lie of omission
		 * about a number the user may be relying on). So we register a *second*
		 * contribution on the same slot — `id: "workbuddy-multi-credits"`, `order: 11` —
		 * which sums the whole pool.
		 *
		 * The two chips therefore coexist on purpose and answer different questions:
		 * upstream's is "what does the account I am using right now have?", ours is
		 * "what does this group have together?".
		 */

		/** The frozen `variantKey` domain, in the order the card lists it. */
		const CREDIT_VARIANT_KEYS = ["cn", "ai"];

		/**
		 * The two BASE routes a merged group runs on, mapped to their variant.
		 *
		 * In merged mode the pool rotates accounts *inside* these upstream routes, so
		 * the route id is the whole story: `workbuddy` is the domestic group,
		 * `workbuddy-ai` the international one. A per-account route id (the pinned
		 * `workbuddy-m-<uid8>` family) is deliberately absent — a single account's own
		 * group has nothing to sum, and the chip stays hidden there.
		 */
		const BASE_ROUTE_VARIANT = {
			workbuddy: "cn",
			"workbuddy-ai": "ai"
		};

		/**
		 * The chip's copy prefix per variant, mirroring upstream's `card.creditPrefix`
		 * (`"WB."` / `"WB AI."`) with 合计 added, so the two chips are told apart by
		 * more than their number.
		 */
		/**
		 * Retained for the internals contract only — the visible chip no longer uses a prefix.
		 *
		 * The composer's control row measures its own children and, when they do not fit, sets
		 * `data-model-compact` on the row; the conversation client's CSS then hides **both** the
		 * model name and the seat's effort readout (`--dsh-composer-model-text-display`), leaving
		 * only an icon. Our chip shares that row with the model seat, so every pixel it spends is
		 * a pixel the model name loses. The chip therefore carries the bare total — no prefix and
		 * no `（积分）` unit (~44px) — and the unit lives in the tooltip instead.
		 */
		const CREDIT_PREFIX = { cn: "WB 合计.", ai: "WB AI 合计." };

		/**
		 * Display names used when `status().variants` has not arrived yet.
		 *
		 * Deliberately not localized: these are the upstream product names, and the live
		 * `displayName` from the host replaces them as soon as a read succeeds.
		 */
		const CREDIT_FALLBACK_NAME = { cn: "WorkBuddy", ai: "WorkBuddy AI" };

		/**
		 * Error codes the host's credits aggregate can carry, mapped to copy.
		 *
		 * Only the codes with something useful to say are listed; anything else falls
		 * back to showing the raw code, so an unanticipated failure is still legible
		 * rather than silently becoming "unknown".
		 */
		const CREDIT_ERROR_KEYS = {
			"encrypted-credential": "creditsErrEncrypted",
			"no-credential": "creditsErrNoCredential",
			"snapshot-missing": "creditsErrSnapshotMissing",
			"snapshot-unreadable": "creditsErrSnapshotUnreadable",
			"pool-incomplete": "creditsErrPoolIncomplete",
			"pool-list-failed": "creditsErrPoolList",
			timeout: "creditsErrTimeout",
			aborted: "creditsErrAborted",
			"fetch-failed": "creditsErrFetch",
			"client-unavailable": "creditsErrClient",
			"bad-response": "creditsErrBadResponse"
		};

		/** The route id a session has selected, or `undefined` when nothing is selected. */
		function providerOf(selection) {
			if (selection === null || typeof selection !== "object") return void 0;
			return typeof selection.provider === "string" ? selection.provider : void 0;
		}

		/**
		 * The variant a selected route id belongs to, or `undefined`.
		 *
		 * `undefined` is the answer for "not one of our base routes" *and* for "no route
		 * selected yet"; both mean the chip must not render.
		 */
		function variantKeyForProvider(provider) {
			if (typeof provider !== "string") return void 0;
			return BASE_ROUTE_VARIANT[provider];
		}

		/** Is the pool in merged mode? Read defensively — this runs before `ready`. */
		function isMergedMode(status) {
			if (status === void 0 || status === null) return false;
			const groups = status.groups;
			if (groups === null || typeof groups !== "object" || Array.isArray(groups)) return false;
			return groups.mode === "merged";
		}

		/**
		 * Our host's credit aggregate for one variant, or `undefined` when it has none.
		 *
		 * `null` is the host's documented "never computed / feature off" answer, and it
		 * must not be confused with a computed zero: §3.6.0 is explicit that 0 is never
		 * a stand-in for 未知.
		 */
		function creditsFor(credits, variantKey) {
			if (credits === null || typeof credits !== "object" || Array.isArray(credits)) return void 0;
			const value = credits[variantKey];
			if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
			return value;
		}

		/** The group's total as a display string: `∞`, a formatted number, or `undefined`. */
		function formatCreditTotal(aggregate) {
			if (aggregate === void 0) return void 0;
			if (aggregate.unlimited === true) return "∞";
			const total = aggregate.total;
			if (typeof total !== "number" || !Number.isFinite(total)) return void 0;
			return new Intl.NumberFormat(void 0, { maximumFractionDigits: 2 }).format(total);
		}

		/**
		 * One account's right-hand cell: its number, or the honest reason there is none.
		 *
		 * Order matters. `unlimited` outranks `total` — an unlimited account is not a
		 * zero. A real number outranks the error, because the host borrows upstream's
		 * number for the encrypted *active* account and records the borrow in `source`,
		 * not by keeping `error`.
		 */
		function creditAccountValue(account, t) {
			if (account === null || typeof account !== "object") return t("creditsUnknown");
			if (account.unlimited === true) return "∞";
			const total = account.total;
			if (typeof total === "number" && Number.isFinite(total)) {
				return new Intl.NumberFormat(void 0, { maximumFractionDigits: 2 }).format(total);
			}
			const error = typeof account.error === "string" && account.error !== "" ? account.error : void 0;
			if (error === void 0) return t("creditsUnknown");
			const key = CREDIT_ERROR_KEYS[error];
			return key === void 0 ? t("creditsAccountError", { error }) : t(key);
		}

		/**
		 * The card's per-variant total line.
		 *
		 * `不完整` is appended only when there is a number to qualify: saying "未知 · 不完整"
		 * twice about one absence is noise, and it would make an uncomputed pool look
		 * like a partial one.
		 */
		function creditSummaryText(aggregate, t) {
			if (aggregate === void 0) return t("creditsNeverComputed");
			const ready = typeof aggregate.readyCount === "number" && Number.isFinite(aggregate.readyCount) ? Math.max(0, Math.trunc(aggregate.readyCount)) : 0;
			const count = typeof aggregate.accountCount === "number" && Number.isFinite(aggregate.accountCount) ? Math.max(0, Math.trunc(aggregate.accountCount)) : 0;
			const counts = t("creditsCounts", { ready, count });
			const total = formatCreditTotal(aggregate);
			if (total === void 0) return `${t("creditsUnknown")} · ${counts}`;
			const base = t("creditsTotal", { total });
			return aggregate.complete === false ? `${base} · ${t("creditsIncomplete")} · ${counts}` : `${base} · ${counts}`;
		}

		/**
		 * The chip's full label.
		 *
		 * `未知` rather than a blank when nothing is known yet: the chip is the only
		 * place a user can find out that a group total exists, so it stays visible with
		 * its refresh control rather than disappearing whenever the pool has not been
		 * counted.
		 */
		function creditChipLabel(status, variantKey, t) {
			const aggregate = creditsFor(status === void 0 ? void 0 : status.credits, variantKey);
			const total = formatCreditTotal(aggregate);
			if (total === void 0) return t("creditsChipUnknown");
			const base = t("creditsChip", { total });
			return aggregate.complete === false ? t("creditsChipIncomplete", { base }) : base;
		}

		/** The group's display name for the tooltip heading, live name first, product name as fallback. */
		function groupNameFor(status, variantKey) {
			for (const variant of arrayOf(status === void 0 ? void 0 : status.variants)) {
				if (variant !== null && typeof variant === "object" && variant.key === variantKey && typeof variant.displayName === "string" && variant.displayName !== "") {
					return variant.displayName;
				}
			}
			return CREDIT_FALLBACK_NAME[variantKey] ?? "";
		}

		/**
		 * The chip's tooltip: one `<uid 前 8> → 数` line per account, then what a click does.
		 *
		 * The same two-part shape upstream uses for its own tooltips: state first, action
		 * second.
		 */
		function creditTooltip(aggregate, name, t) {
			const lines = [t("creditsTooltipHeading", { name })];
			for (const account of arrayOf(aggregate === void 0 ? void 0 : aggregate.accounts)) {
				lines.push(t("creditsTooltipAccount", {
					uid: shortUid(account?.uid),
					value: creditAccountValue(account, t)
				}));
			}
			lines.push(t("creditsRefreshPooled"));
			return lines.join("\n");
		}

		/**
		 * Should the chip render in this conversation, and for which variant?
		 *
		 * Both conditions are the spec's, and both are load-bearing: in `per-account`
		 * mode every account already has its own model group and its own credit figure,
		 * so a group total would be a number about nothing; and on any provider that is
		 * not one of our two base routes the pool is irrelevant to what the user is
		 * about to send.
		 */
		function chipVariantKey(status, provider) {
			if (!isMergedMode(status)) return void 0;
			return variantKeyForProvider(provider);
		}

		/**
		 * Would a TTL-respecting refresh actually produce a different number?
		 *
		 * True when nothing has been counted yet, and true once the aggregate is older
		 * than the host's TTL — because below the TTL the host hands back the same cached
		 * value, so asking would be a POST that cannot change anything. This mirrors the
		 * host's rule instead of inventing a second one.
		 */
		function creditsStale(aggregate, ttlMs, now) {
			if (aggregate === void 0) return true;
			const computedAt = aggregate.computedAt;
			if (typeof computedAt !== "number" || !Number.isFinite(computedAt)) return true;
			const ttl = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : CREDITS_TTL_FALLBACK_MS;
			return now - computedAt >= ttl;
		}
		//#endregion

		//#region src/host.js
		/**
		 * Read the host's status document.
		 *
		 * Same-origin `fetch` with no explicit `Origin` header: the host admits the
		 * request as loopback from `Host` alone, and an `Origin` that is not itself
		 * loopback would be rejected. `credentials: "same-origin"` is what upstream uses
		 * and keeps the cookie jar in play without widening the request.
		 */
		async function fetchStatus(signal) {
			const response = await fetch(STATUS_PATH, {
				headers: { accept: "application/json" },
				credentials: "same-origin",
				...(signal === void 0 ? {} : { signal })
			});
			const body = await response.json().catch(() => void 0);
			if (!response.ok) {
				/*
				 * The host answers a not-ready `503` with a human-readable `error` *and* a
				 * status shell, precisely so the card can show the little it knows
				 * (warnings, an empty variant list) before the pool finishes booting
				 * instead of waiting a whole poll interval. Carry that shell on the error
				 * rather than dropping it; `refresh` decides whether to render it.
				 */
				const failure = new Error(envelopeError(body) ?? `HTTP ${response.status}`);
				if (body !== null && typeof body === "object") failure.status = body.status;
				throw failure;
			}
			const value = unwrapEnvelope(body);
			if (!isStatusDocument(value)) throw new Error("invalid status response");
			return value;
		}

		/**
		 * Invoke one frozen host action and return its `result` payload.
		 *
		 * The body is `{ action, ...parameters }`, where the parameter names are the
		 * frozen signature's parameter names verbatim (`variantKey`, `uid`, `on`,
		 * `label`, `paths`, `policy`, `loginId`).
		 *
		 * The returned `result` is NOT the truth about pool state: every *state
		 * changing* caller re-reads the status document afterwards, so a host that
		 * answers `{ok:true}` with no `result` still leaves the card correct, and
		 * `advance` answering `{uid: undefined}` (no usable account) is not a failure —
		 * only `ok:false` and a non-2xx status are.
		 *
		 * It IS returned, though, because the login flow has no other source for it:
		 * `loginStart` carries `{loginId, verificationUri, expiresIn}` and `loginPoll`
		 * carries the pending/terminal state, neither of which exists in `status()`
		 * until the account has actually landed in the pool. Note that a login's own
		 * `result.ok === false` (a failed or expired sign-in) is a *login* outcome on a
		 * `200 {ok:true}` envelope, so it must not be confused with an envelope
		 * failure — the envelope is unwrapped first and only `body.ok === false` throws.
		 */
		async function postAction(action, parameters, signal) {
			const response = await fetch(ACTION_PATH, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					accept: "application/json"
				},
				credentials: "same-origin",
				body: JSON.stringify({ action, ...parameters }),
				...(signal === void 0 ? {} : { signal })
			});
			const body = await response.json().catch(() => void 0);
			if (!response.ok || (body !== null && typeof body === "object" && body.ok === false)) throw new Error(envelopeError(body) ?? `HTTP ${response.status}`);
			return unwrapEnvelope(body);
		}
		//#endregion

		//#region src/locale.js
		/**
		 * Card copy, registered under the `settings.workbuddyMulti` locale namespace.
		 * `zh` is the fallback string the card renders when a host locale has no entry,
		 * which is also why `t()` below can fall back to this table.
		 *
		 * Copy rules: say what is true and what to do. No restating the obvious state
		 * ("运行正常"), no explaining why a rule exists — the README carries that.
		 */
		const zh = {
			cardTitle: "WorkBuddy 多账号",
			cardIntro: "WorkBuddy 多账号轮换、扫码添加与令牌自动续期",
			loading: "读取中…",
			readFailed: "读取状态失败",
			refresh: "刷新",
			refreshing: "刷新中…",
			expand: "展开",
			collapse: "收起",
			more: "更多操作",
			summaryEmpty: "暂无账号",
			summaryCounts: "国内版 {cn} 个 · 国际版 {ai} 个",
			busy: "处理中…",

			// ── 顶栏：自动续期 ───────────────────────────────────────────────────
			keepaliveHeading: "自动续期",
			keepaliveRunning: "运行中",
			keepaliveStopped: "已停止",
			keepaliveLastSweep: "上次检查 {time}",
			keepaliveNever: "尚未检查",
			keepaliveStats: "上次检查：刷新成功 {ok} 个，失败 {failed} 个，跳过 {skipped} 个",
			keepaliveFailed: "{n} 个账号令牌刷新失败",
			keepaliveUnavailable: "不可用：{reason}",

			// ── 上游依赖 ─────────────────────────────────────────────────────
			upstreamHeading: "缺少依赖插件 dsh-workbuddy-connect",
			upstreamBody: "本插件为其提供多账号功能，需与其配合使用。",
			upstreamChecking: "正在检查…",
			upstreamInstalling: "正在通过插件市场安装 dsh-workbuddy-connect…",
			upstreamEnabling: "dsh-workbuddy-connect 已安装但处于停用状态，正在启用…",
			upstreamInstalled: "dsh-workbuddy-connect 已安装，刷新页面后生效。",
			upstreamNeedsRestart: "dsh-workbuddy-connect 已安装，重启 DSH 后生效。",
			upstreamFailed: "自动安装失败：{error}",
			upstreamNoMarket: "未检测到插件市场。请在「插件」页搜索 dsh-workbuddy-connect 安装，或在终端运行：",
			upstreamInstall: "一键安装",
			upstreamRetry: "重试",
			upstreamReload: "刷新页面",

			// ── 需要处理 ─────────────────────────────────────────────────────
			warningsHeading: "需要处理",

			// ── 账号 ─────────────────────────────────────────────────────────
			variantCn: "国内版",
			variantAi: "国际版",
			variantCredits: "共 {total} 积分",
			accountCredits: "{n} 积分",
			accountCreditsUnknown: "积分未知",
			variantCreditsPartial: "已知 {total} 积分（{ready}/{count} 个账号）",
			noAccounts: "暂无账号",
			noAccountsHint: "通过「添加账号」扫码登录，或在右侧菜单中从桌面 App 导入。",

			accountActive: "当前",
			accountDisabled: "已停用",
			accountCooling: "限流至 {time}",
			accountExpired: "登录已过期",
			accountDead: "不可用",
			accountNeedsRelogin: "需重新登录",
			accountNeedsReloginReason: "原因：{reason}",
			accountLastRefreshError: "上次刷新失败：{error}",
			accountJustAdded: "新添加",
			accountSourceDesktop: "桌面 App",
			accountSourceOauth: "扫码登录",
			accountSourceImport: "导入",
			accountLastUsed: "最近使用 {time}",
			accountNeverUsed: "尚未使用",
			expiresInSeconds: "{n} 秒后到期",
			expiresInMinutes: "{n} 分钟后到期",
			expiresInHours: "{n} 小时后到期",
			expiresInDays: "{n} 天后到期",
			expiresExpired: "已过期",

			actionSelect: "设为当前",
			actionAdvance: "切换至下一账号",
			actionEnable: "启用",
			actionDisable: "停用",
			actionRename: "重命名",
			actionRemove: "删除",
			actionRefreshAccount: "刷新令牌",
			actionCapture: "从桌面 App 导入当前账号",
			actionImport: "导入授权文件…",

			importHeading: "导入授权文件",
			importPlaceholder: "每行填写一个文件的绝对路径",
			importSubmit: "导入",
			importCancel: "取消",
			importNote: "国内版授权文件由本机 App 密钥加密，仅可在本机使用。",
			importEmpty: "请至少填写一个文件路径。",

			renamePlaceholder: "显示名",
			renameSubmit: "保存",
			renameCancel: "取消",
			removeConfirm: "确定删除 {label}？仅删除本插件保存的副本，不影响桌面 App 的登录状态。",
			confirmYes: "删除",
			confirmNo: "取消",

			// ── 添加账号（扫码登录）─────────────────────────────────────────
			loginHeading: "添加账号",
			loginChoose: "版本",
			loginVariantCn: "国内版",
			loginVariantAi: "国际版",
			loginStart: "生成登录链接",
			loginStarting: "生成中…",
			loginOpen: "打开登录页",
			loginCopy: "复制链接",
			loginCopied: "已复制",
			loginCopyFailed: "复制失败，请手动复制上方链接。",
			loginScanHint: "请在浏览器或手机中打开登录页，使用微信扫码登录。",
			loginManualHint: "打开登录页，用邮箱或第三方账号手动登录；完成后这里会自动确认。",
			loginWaitingManual: "等待登录完成",
			loginCountdown: "{time} 后失效",
			loginWaiting: "等待扫码",
			loginSucceeded: "登录成功，账号已添加。",
			loginFailed: "登录失败",
			loginExpired: "链接已失效，请重新生成。",
			loginRetry: "重新生成",
			loginCancel: "取消",
			loginCancelled: "已取消。",
			loginClose: "关闭",
			loginNoToken: "插件不会显示或复制任何令牌。",

			// ── 设置 ─────────────────────────────────────────────────────────
			settingsHeading: "设置",
			policyHeading: "账号轮换",
			policyOnRateLimit: "限流时切换",
			policyOnRateLimitHint: "持续使用当前账号；触发频率限制或额度耗尽时，暂停该账号至额度恢复，并切换至下一个可用账号。",
			policyRoundRobin: "逐次轮换",
			policyRoundRobinHint: "每个请求依次使用下一个可用账号，已停用或限流中的账号不参与。",
			policyManual: "手动指定",
			policyManualHint: "不自动切换，仅使用手动设为当前的账号。",
			groupsHeading: "模型分组",
			groupsMerged: "按版本合并",
			groupsMergedHint: "国内版与国际版各对应一个模型组，组内账号自动轮换。",
			groupsPerAccount: "按账号分组",
			groupsPerAccountHint: "每个账号对应一个独立模型组，可在模型选择器中直接选用。",
			pinnedHeading: "模型选择器中的分组",
			pinnedAccountEmpty: "暂无已启用的账号。",
			pinnedPendingRestart: "新添加的账号需重启 DSH 后才会出现在模型选择器中。",

			// ── 积分 ─────────────────────────────────────────────────────────
			creditsRefresh: "刷新积分",
			/**
			 * The chip's own ↻. Deliberately NOT the same string as upstream's refresh
			 * label: the composer CSS retires upstream's single-account number by
			 * anchoring on that label, so sharing it would hide our button too.
			 */
			creditsRefreshPooled: "刷新账号池积分",
			creditsChip: "{total}",
			creditsChipUnknown: "—",
			creditsChipIncomplete: "{base} ·不完整",
			creditsTooltipHeading: "{name} · 账号池合计",
			creditsTooltipAccount: "{uid} → {value}",
			creditsTotal: "合计 {total} 积分",
			creditsCounts: "{ready}/{count} 个账号已统计",
			creditsIncomplete: "不完整",
			creditsUnknown: "未知",
			creditsNeverComputed: "尚未统计",
			creditsAccountError: "无法获取（{error}）",
			creditsErrEncrypted: "凭据已加密，无法查询",
			creditsErrNoCredential: "缺少凭据",
			creditsErrSnapshotMissing: "本地副本缺失",
			creditsErrSnapshotUnreadable: "本地副本无法读取",
			creditsErrPoolIncomplete: "账号池不完整",
			creditsErrPoolList: "账号池无法读取",
			creditsErrTimeout: "请求超时",
			creditsErrAborted: "请求已取消",
			creditsErrFetch: "请求失败",
			creditsErrClient: "积分查询服务不可用",
			creditsErrBadResponse: "服务返回异常",

			// ── 上游 Connect 设置（一条龙）─────────────────────────────────────
			connectHeading: "WorkBuddy Connect",
			connectCnTitle: "国内版",
			connectAiTitle: "国际版",
			connectUnavailable: "Connect 未就绪：{message}",
			connectSignedInAs: "已登录：{nickname}",
			connectSignedOut: "未登录",
			connectSignedOutHintCn: "在 WorkBuddy 国内版桌面 App 里登录一次即可，这里会自动跟随当前账号。",
			connectSignedOutHintAi: "在 WorkBuddy AI 国际版桌面 App 里登录一次即可，这里会自动跟随当前账号。",
			connectTokenExpires: "访问令牌 {time} 过期",
			connectCredits: "剩余积分",
			connectCreditsError: "积分查询失败：{message}",
			connectCreditsUnknown: "积分未知",
			connectCatalogLive: "模型列表更新于 {time}",
			connectCatalogSaved: "显示已保存的模型列表（{time}）",
			connectCatalogFallback: "显示内置模型列表（尚未从 WorkBuddy 更新）",
			connectCatalogError: "上次更新失败：{message}",
			connectAppVersion: "App 版本 {version}",
			connectRefreshModels: "刷新模型列表",
			connectRefreshingModels: "正在刷新模型…",
			connectModelsHeading: "模型与可见性",
			connectModelDetectedLevels: "检测所得档位",
			connectModelsHeadingCount: "模型与可见性（{count}）",
			connectVisibilityHint: "取消勾选即在模型选择器中隐藏；按当前登录账号保存，已在用该模型的会话不受影响。",
			connectVisibilityStale: "登录账号已切换——本次修改未保存。",
			connectFree: "免费",
			connectRate: "{rate} 积分/次",
			connectRateUnknown: "价格未知",
			connectContextUpTo: "最高 {size}",
			connectContextDefault: "默认 {size}",
			connectContextUnknown: "未声明窗口",
			connectMaxWindow: "使用模型声明的最大上下文窗口",
			connectMaxWindowHint: "仅作用于声明了更大窗口的模型。",
			connectProbeHeading: "推理档位检测",
			connectProbeHeadingCount: "推理档位检测（{count}）",
			connectProbeResolvedGroup: "已检测（{count}）",
			connectProbeAllResolved: "所有可检测模型都已有结果。",
			connectProbeIntro: "部分模型具备思考能力但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。结果按「版本+模型」跨账号共享：任何账号检测过，所有账号都可用。",
			connectProbeStart: "检测",
			connectProbeRedetect: "重新检测",
			connectProbeRunning: "正在检测 {model}…",
			connectProbeAll: "全部检测",
			connectProbeAllConfirm: "将向 {count} 个未有结果的模型依次发送探测请求，可能消耗积分。",
			connectProbeAllProgress: "正在检测 {done}/{total}：{model}",
			connectProbeAllDone: "全部检测完成：成功 {ok} 个，失败 {failed} 个。",
			connectProbeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			connectProbeConfirmAction: "确认检测",
			connectProbeCancel: "取消",
			connectProbeKnown: "已检测：{levels}",
			connectProbeShared: "共享自账号 {account}",
			connectProbeNotValidating: "模型端不校验档位参数",
			connectProbeUnknown: "检测未完成",
			connectProbeUntested: "未检测",
			connectProbeResultAt: "检测于 {time}",
			connectProbeEmpty: "当前没有可检测的模型。",
			connectProbeFailed: "检测失败：{message}",
			connectProbeBusy: "模型繁忙或请求太频繁（429），稍后重试；「全部检测」会自带间隔并自动重试一次",
			connectProbeNoEntitlement: "当前账号类型无权使用该模型（免费版），检测无法进行",
			connectProbeRetrying: "模型繁忙，约 {seconds} 秒后自动重试 {model}…",
			connectAssistantHeading: "让 Agent 帮你处理",
			connectAssistantIntro: "把下面这段请求发给你的 Agent，它会协助检查应用位置和启动配置。",
			connectAssistantCopy: "复制给 Agent",
			connectAssistantCopied: "已复制",
			connectAssistantCopyFailed: "复制失败，请手动选择上方文字复制",
			connectAssistantPrompt: "DSH 的 dsh-workbuddy-connect 无法使用我的 {appName}：{failureSummary}。请帮我检查实际安装位置和已有路径配置，让插件能正确使用它，并验证恢复结果；如果需要修改 DSH 的启动环境或重启，请给我明确的操作步骤，不要只在当前 shell 临时设置环境变量。",

			// ── 推理档位共享 ──────────────────────────────────────────────────
			reasoningHeading: "推理档位共享",
			reasoningOn: "开启",
			reasoningOff: "关闭",
			reasoningCachedCount: "已共享 {count} 个模型的检测结果",
			chipHeading: "输入框积分",
			chipShow: "显示",
			chipHide: "隐藏",
			chipHint: "在输入框右侧显示账号池积分合计；隐藏后设置页里的积分统计不受影响。"
		};

		const en = {
			cardTitle: "WorkBuddy Multi-Account",
			cardIntro: "Rotate WorkBuddy accounts, add them by QR code, and renew tokens automatically",
			loading: "Loading…",
			readFailed: "Could not read status",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			expand: "Expand",
			collapse: "Collapse",
			more: "More actions",
			summaryEmpty: "No accounts yet",
			summaryCounts: "China {cn} · International {ai}",
			busy: "Working…",

			keepaliveHeading: "Auto-renewal",
			keepaliveRunning: "running",
			keepaliveStopped: "stopped",
			keepaliveLastSweep: "last checked {time}",
			keepaliveNever: "not checked yet",
			keepaliveStats: "Last check: {ok} renewed, {failed} failed, {skipped} skipped",
			keepaliveFailed: "{n} account(s) failed to renew",
			keepaliveUnavailable: "Unavailable: {reason}",

			upstreamHeading: "dsh-workbuddy-connect is required",
			upstreamBody: "This plugin adds multi-account support to it and requires it to work.",
			upstreamChecking: "Checking…",
			upstreamInstalling: "Installing dsh-workbuddy-connect through the plugin market…",
			upstreamEnabling: "dsh-workbuddy-connect is installed but disabled — enabling it…",
			upstreamInstalled: "dsh-workbuddy-connect is installed. Reload the page to finish.",
			upstreamNeedsRestart: "dsh-workbuddy-connect is installed. Restart DSH to finish.",
			upstreamFailed: "Automatic install did not succeed: {error}",
			upstreamNoMarket: "No plugin market found. Search for dsh-workbuddy-connect on the Plugins page, or run:",
			upstreamInstall: "Install",
			upstreamRetry: "Retry",
			upstreamReload: "Reload page",

			warningsHeading: "Needs attention",

			variantCn: "China",
			variantAi: "International",
			variantCredits: "{total} credits",
			accountCredits: "{n} credits",
			accountCreditsUnknown: "credits unknown",
			variantCreditsPartial: "{total} credits known ({ready}/{count} accounts)",
			noAccounts: "No accounts yet",
			noAccountsHint: "Sign in with Add account, or import one from the desktop app in the menu.",

			accountActive: "In use",
			accountDisabled: "Disabled",
			accountCooling: "Rate-limited until {time}",
			accountExpired: "Signed out",
			accountDead: "Unusable",
			accountNeedsRelogin: "Sign in again",
			accountNeedsReloginReason: "Reason: {reason}",
			accountLastRefreshError: "Last renewal failed: {error}",
			accountJustAdded: "New",
			accountSourceDesktop: "desktop app",
			accountSourceOauth: "QR sign-in",
			accountSourceImport: "imported",
			accountLastUsed: "last used {time}",
			accountNeverUsed: "never used",
			expiresInSeconds: "expires in {n}s",
			expiresInMinutes: "expires in {n} min",
			expiresInHours: "expires in {n}h",
			expiresInDays: "expires in {n}d",
			expiresExpired: "expired",

			actionSelect: "Use this",
			actionAdvance: "Switch to next account",
			actionEnable: "Enable",
			actionDisable: "Disable",
			actionRename: "Rename",
			actionRemove: "Remove",
			actionRefreshAccount: "Renew token",
			actionCapture: "Import current desktop app account",
			actionImport: "Import auth files…",

			importHeading: "Import auth files",
			importPlaceholder: "One absolute file path per line",
			importSubmit: "Import",
			importCancel: "Cancel",
			importNote: "China-edition auth files are encrypted with this computer's app key and only work here.",
			importEmpty: "Enter at least one file path.",

			renamePlaceholder: "Display name",
			renameSubmit: "Save",
			renameCancel: "Cancel",
			removeConfirm: "Remove {label}? Only this plugin's copy is deleted; the desktop app stays signed in.",
			confirmYes: "Remove",
			confirmNo: "Cancel",

			loginHeading: "Add account",
			loginChoose: "Edition",
			loginVariantCn: "China",
			loginVariantAi: "International",
			loginStart: "Create sign-in link",
			loginStarting: "Creating…",
			loginOpen: "Open sign-in page",
			loginCopy: "Copy link",
			loginCopied: "Copied",
			loginCopyFailed: "Copy failed — copy the link above by hand.",
			loginScanHint: "Open the sign-in page in a browser or on your phone and scan with WeChat.",
			loginManualHint: "Open the sign-in page and sign in manually (email or third-party account); this panel confirms automatically once done.",
			loginWaitingManual: "Waiting for sign-in",
			loginCountdown: "expires in {time}",
			loginWaiting: "Waiting for scan",
			loginSucceeded: "Signed in. The account has been added.",
			loginFailed: "Sign-in failed",
			loginExpired: "The link expired — create a new one.",
			loginRetry: "Create new link",
			loginCancel: "Cancel",
			loginCancelled: "Cancelled.",
			loginClose: "Close",
			loginNoToken: "The plugin never shows or copies tokens.",

			settingsHeading: "Settings",
			policyHeading: "Rotation",
			policyOnRateLimit: "On rate limit",
			policyOnRateLimitHint: "Keep using the current account; when it hits a rate limit or runs out of quota, pause it until the quota resets and switch to the next available account.",
			policyRoundRobin: "Per request",
			policyRoundRobinHint: "Each request uses the next available account; disabled and rate-limited accounts are skipped.",
			policyManual: "Manual",
			policyManualHint: "Never switch automatically; only the account set as current is used.",
			groupsHeading: "Model groups",
			groupsMerged: "Per edition",
			groupsMergedHint: "One model group each for China and International; accounts rotate within the group.",
			groupsPerAccount: "Per account",
			groupsPerAccountHint: "Each account has its own model group, selectable in the model selector.",
			pinnedHeading: "Groups in the model selector",
			pinnedAccountEmpty: "No enabled accounts.",
			pinnedPendingRestart: "Newly added accounts appear in the model selector after DSH restarts.",

			creditsRefresh: "Refresh credits",
			creditsRefreshPooled: "Refresh pooled credits",
			creditsChip: "{total}",
			creditsChipUnknown: "—",
			creditsChipIncomplete: "{base} ·incomplete",
			creditsTooltipHeading: "{name} · pooled total",
			creditsTooltipAccount: "{uid} → {value}",
			creditsTotal: "{total} credits total",
			creditsCounts: "{ready}/{count} accounts answered",
			creditsIncomplete: "incomplete",
			creditsUnknown: "unknown",
			creditsNeverComputed: "not counted yet",
			creditsAccountError: "unavailable ({error})",
			creditsErrEncrypted: "encrypted credential",
			creditsErrNoCredential: "no credential",
			creditsErrSnapshotMissing: "copy missing",
			creditsErrSnapshotUnreadable: "copy unreadable",
			creditsErrPoolIncomplete: "pool incomplete",
			creditsErrPoolList: "pool unreadable",
			creditsErrTimeout: "timed out",
			creditsErrAborted: "cancelled",
			creditsErrFetch: "request failed",
			creditsErrClient: "upstream unavailable",
			creditsErrBadResponse: "unexpected response",

			// ── Upstream Connect settings (one-stop) ─────────────────────────────
			connectHeading: "WorkBuddy Connect",
			connectCnTitle: "China",
			connectAiTitle: "International",
			connectUnavailable: "Upstream unavailable: {message}",
			connectSignedInAs: "Signed in as {nickname}",
			connectSignedOut: "Not signed in",
			connectSignedOutHintCn: "Sign in once in the WorkBuddy desktop app (China edition); the upstream plugin follows that sign-in automatically.",
			connectSignedOutHintAi: "Sign in once in the WorkBuddy AI desktop app; the upstream plugin follows that sign-in automatically.",
			connectTokenExpires: "Access token expires {time}",
			connectCredits: "Remaining credit",
			connectCreditsError: "Credit unavailable: {message}",
			connectCreditsUnknown: "Credit unknown",
			connectCatalogLive: "Model list updated {time}",
			connectCatalogSaved: "Showing the saved model list from {time}",
			connectCatalogFallback: "Showing the built-in model list (not yet updated from WorkBuddy)",
			connectCatalogError: "Last update failed: {message}",
			connectAppVersion: "App version {version}",
			connectRefreshModels: "Refresh model list",
			connectRefreshingModels: "Refreshing models…",
			connectModelsHeading: "Models & visibility",
			connectModelDetectedLevels: "Detected levels",
			connectModelsHeadingCount: "Models & visibility ({count})",
			connectVisibilityHint: "Uncheck a model to hide it from the model picker. Saved per signed-in account; chats already using a hidden model keep working.",
			connectVisibilityStale: "The signed-in account changed — this change was not saved.",
			connectFree: "Free",
			connectRate: "{rate} credits per message",
			connectRateUnknown: "Price unavailable",
			connectContextUpTo: "up to {size}",
			connectContextDefault: "default {size}",
			connectContextUnknown: "no declared window",
			connectMaxWindow: "Use the largest declared context window",
			connectMaxWindowHint: "Applies to models that declare a larger window.",
			connectProbeHeading: "Reasoning effort detection",
			connectProbeHeadingCount: "Reasoning effort detection ({count})",
			connectProbeResolvedGroup: "Detected ({count})",
			connectProbeAllResolved: "Every detectable model has a result.",
			connectProbeIntro: "Some models reason but declare no selectable effort levels. Detection sends a few real requests and may consume credit. Results are shared per version+model across accounts: once any account has detected a model, every account can use it.",
			connectProbeStart: "Detect",
			connectProbeRedetect: "Detect again",
			connectProbeRunning: "Detecting {model}…",
			connectProbeAll: "Detect all",
			connectProbeAllConfirm: "Send probe requests to {count} models that have no result yet, one after another. May consume credit.",
			connectProbeAllProgress: "Detecting {done}/{total}: {model}",
			connectProbeAllDone: "Detection finished: {ok} succeeded, {failed} failed.",
			connectProbeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			connectProbeConfirmAction: "Confirm",
			connectProbeCancel: "Cancel",
			connectProbeKnown: "Detected: {levels}",
			connectProbeShared: "Shared from account {account}",
			connectProbeNotValidating: "Upstream does not validate the effort parameter",
			connectProbeUnknown: "Detection did not complete",
			connectProbeUntested: "Not detected",
			connectProbeResultAt: "Detected {time}",
			connectProbeEmpty: "No detectable models right now.",
			connectProbeFailed: "Detection failed: {message}",
			connectProbeBusy: "Model busy or rate-limited (429) — try again later; \"Detect all\" paces itself and retries once automatically",
			connectProbeNoEntitlement: "This account type (free) is not allowed to use the model, so detection cannot run",
			connectProbeRetrying: "Model busy; retrying {model} in ~{seconds}s…",
			connectAssistantHeading: "Let an Agent sort this out",
			connectAssistantIntro: "Send the request below to your Agent; it will check the app location and the launch configuration for you.",
			connectAssistantCopy: "Copy for Agent",
			connectAssistantCopied: "Copied",
			connectAssistantCopyFailed: "Copy failed — select the text above and copy it manually",
			connectAssistantPrompt: "DSH's dsh-workbuddy-connect cannot use my {appName}: {failureSummary}. Please check the actual installation location and any existing path configuration, help the plugin use it correctly, and verify recovery. If the DSH launch environment must be changed or DSH restarted, give me clear steps; do not only set an environment variable temporarily in the current shell.",

			// ── Reasoning effort sharing ───────────────────────────────────────────
			reasoningHeading: "Reasoning effort sharing",
			reasoningOn: "On",
			reasoningOff: "Off",
			reasoningCachedCount: "{count} model(s) shared",
			chipHeading: "Composer credit",
			chipShow: "Show",
			chipHide: "Hide",
			chipHint: "Show the pooled credit total next to the composer. Hiding it does not affect the credit breakdown on this page."
		};

		const DICTIONARIES = { zh, en };

		/** Identity translator, used when the host locale service is unavailable. */
		function defaultTranslate(key) {
			return DICTIONARIES.zh[key] ?? key;
		}
		//#endregion

		//#region src/styles.js
		/**
		 * One scoped stylesheet for the settings surface, installed once per document.
		 *
		 * A stylesheet rather than inline styles because the surface needs what inline
		 * styles cannot express: hover and focus states, a menu that closes on outside
		 * click, and a container query that re-flows account rows on a narrow panel.
		 *
		 * Every colour is a DSH `--dsw-alias-*` token, so light and dark follow the host.
		 * The palette is deliberately the host's own monochrome: black primary actions,
		 * neutral greys, and the state colours only where a state is being reported.
		 */
		const UI_CSS_TAG = "dsh-workbuddy-multi/ui.css";
		const UI_CSS = `
.wbm{--wbm-fg:var(--dsw-alias-label-primary,#0f1115);--wbm-fg2:var(--dsw-alias-label-secondary,#61666b);--wbm-fg3:var(--dsw-alias-label-tertiary,#81858c);--wbm-line:var(--dsw-alias-border-l2,#0000001a);--wbm-line-soft:var(--dsw-alias-border-l1,#0000000a);--wbm-surface:var(--dsw-alias-bg-layer-1,#fff);--wbm-sunken:var(--dsw-alias-bg-module-platform,#f5f6f7);--wbm-primary:var(--dsw-alias-button-primary-fill,#0f1115);--wbm-on-primary:var(--dsw-alias-label-primary-foreground,#fff);--wbm-ok:var(--dsw-alias-state-success-primary,#22c55e);--wbm-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--wbm-warn-bg:var(--dsw-alias-state-warn-tertiary,#fef5e7);--wbm-err:var(--dsw-alias-state-error-primary,#ec1313);
container-type:inline-size;container-name:wbm;display:flex;flex-direction:column;gap:20px;min-width:0;color:var(--wbm-fg);font-size:13px;line-height:20px;-webkit-font-smoothing:antialiased}
.wbm *{box-sizing:border-box}
.wbm p{margin:0}
.wbm-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}
.wbm-bar-status{display:flex;align-items:center;gap:8px;min-width:0;color:var(--wbm-fg2)}
.wbm-bar-status b{font-weight:500;color:var(--wbm-fg)}
.wbm-bar-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.wbm-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--wbm-fg3)}
.wbm-dot--ok{background:var(--wbm-ok)}
.wbm-dot--warn{background:var(--wbm-warn)}
.wbm-dot--err{background:var(--wbm-err)}
.wbm-dot--off{background:transparent;box-shadow:inset 0 0 0 1.5px var(--wbm-fg3)}
.wbm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--wbm-line);border-radius:8px;background:var(--wbm-surface);color:var(--wbm-fg);font:inherit;font-size:13px;font-weight:500;white-space:nowrap;cursor:pointer;text-decoration:none;transition:background-color .12s ease,border-color .12s ease,opacity .12s ease}
.wbm-btn:hover{background:var(--wbm-sunken)}
.wbm-btn:focus-visible,.wbm-icon:focus-visible,.wbm-seg button:focus-visible,.wbm-menu-item:focus-visible{outline:2px solid var(--wbm-fg);outline-offset:1px}
.wbm-btn:disabled{opacity:.5;cursor:default}
.wbm-btn:disabled:hover{background:var(--wbm-surface)}
.wbm-btn--primary{border-color:var(--wbm-primary);background:var(--wbm-primary);color:var(--wbm-on-primary)}
.wbm-btn--primary:hover{background:var(--wbm-primary);opacity:.86}
.wbm-btn--primary:disabled:hover{background:var(--wbm-primary)}
.wbm-btn--quiet{border-color:transparent;background:transparent;color:var(--wbm-fg2)}
.wbm-btn--quiet:hover{background:var(--wbm-sunken);color:var(--wbm-fg)}
.wbm-btn--sm{height:26px;padding:0 10px;font-size:12px}
.wbm-btn--danger{color:var(--wbm-err);border-color:var(--wbm-err)}
.wbm-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--wbm-fg2);cursor:pointer}
.wbm-icon:hover{background:var(--wbm-sunken);color:var(--wbm-fg)}
.wbm-icon:disabled{opacity:.45;cursor:default}
.wbm-icon svg{width:16px;height:16px}
.wbm-spin{animation:wbm-spin .9s linear infinite}
@keyframes wbm-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wbm-spin{animation:none}.wbm-btn,.wbm-seg button{transition:none}}
.wbm-banner{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--wbm-line);border-radius:10px;background:var(--wbm-surface)}
.wbm-banner--warn{border-color:color-mix(in srgb,var(--wbm-warn) 45%,transparent);background:var(--wbm-warn-bg)}
.wbm-banner--err{border-color:color-mix(in srgb,var(--wbm-err) 40%,transparent);background:color-mix(in srgb,var(--wbm-err) 6%,var(--wbm-surface))}
.wbm-banner-title{display:flex;align-items:center;gap:8px;font-weight:600}
.wbm-banner-title svg{flex:0 0 auto;width:14px;height:14px}
.wbm-banner-text{color:var(--wbm-fg2)}
.wbm-banner ul{margin:0;padding-left:18px;color:var(--wbm-fg2)}
.wbm-banner-actions{display:flex;flex-wrap:wrap;gap:8px}
.wbm-code{display:block;max-width:100%;overflow-wrap:anywhere;padding:6px 9px;border-radius:6px;background:var(--wbm-sunken);font-size:12px;user-select:all}
.wbm-error{color:var(--wbm-err)}
.wbm-muted{color:var(--wbm-fg3)}
.wbm-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.wbm-section-head{display:flex;align-items:center;gap:10px;min-width:0;min-height:28px}
.wbm-section-title{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:8px;min-width:0;flex:1 1 auto}
.wbm-section-title h3{margin:0;font-size:14px;line-height:22px;font-weight:600;white-space:nowrap}
.wbm-section-title span{color:var(--wbm-fg3);font-size:12px;min-width:0;overflow-wrap:anywhere}
.wbm-list{margin:0;padding:0;list-style:none;border:1px solid var(--wbm-line);border-radius:10px;background:var(--wbm-surface)}
.wbm-row{position:relative;display:grid;grid-template-columns:7px minmax(0,1fr) auto;column-gap:12px;row-gap:8px;align-items:center;padding:11px 12px 11px 14px}
.wbm-row+.wbm-row{border-top:1px solid var(--wbm-line-soft)}
.wbm-row--fresh{box-shadow:inset 3px 0 0 var(--wbm-fg)}
.wbm-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.wbm-row-title{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.wbm-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%}
.wbm-row--off .wbm-name{color:var(--wbm-fg3)}
.wbm-meta{color:var(--wbm-fg3);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.wbm-note{font-size:12px;line-height:18px;overflow-wrap:anywhere}
.wbm-note--warn{color:var(--wbm-fg2)}
.wbm-note--err{color:var(--wbm-err)}
.wbm-row-side{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.wbm-credit{font-variant-numeric:tabular-nums;color:var(--wbm-fg2);font-size:12px;white-space:nowrap;margin-right:4px}
.wbm-row-panel{grid-column:2 / -1}
.wbm-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:var(--wbm-sunken);color:var(--wbm-fg2);font-size:11px;font-weight:500;line-height:18px;white-space:nowrap}
.wbm-tag--strong{background:var(--wbm-primary);color:var(--wbm-on-primary)}
.wbm-tag--warn{background:var(--wbm-warn-bg);color:var(--wbm-fg)}
.wbm-tag--err{background:color-mix(in srgb,var(--wbm-err) 12%,transparent);color:var(--wbm-err)}
.wbm-empty{display:flex;flex-direction:column;gap:2px;padding:16px 14px;color:var(--wbm-fg2)}
.wbm-empty b{font-weight:500;color:var(--wbm-fg)}
.wbm-menu{position:relative;display:inline-flex}
.wbm-menu-pop{position:absolute;top:calc(100% + 4px);right:0;z-index:30;display:flex;flex-direction:column;min-width:168px;max-width:min(260px,80vw);padding:4px;border:1px solid var(--wbm-line);border-radius:10px;background:var(--wbm-surface);box-shadow:0 8px 24px rgba(0,0,0,.12),0 1px 3px rgba(0,0,0,.06)}
.wbm-menu-item{display:block;width:100%;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--wbm-fg);font:inherit;font-size:13px;text-align:left;white-space:nowrap;cursor:pointer}
.wbm-menu-item:hover{background:var(--wbm-sunken)}
.wbm-menu-item:disabled{opacity:.45;cursor:default}
.wbm-menu-item--danger{color:var(--wbm-err)}
.wbm-menu-sep{height:1px;margin:4px 6px;background:var(--wbm-line-soft)}
.wbm-panel{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--wbm-line);border-radius:10px;background:var(--wbm-surface)}
.wbm-panel--sunken{background:var(--wbm-sunken);border-color:transparent}
.wbm-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wbm-panel-head b{font-weight:600}
.wbm-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.wbm-input{width:100%;height:30px;padding:0 10px;border:1px solid var(--wbm-line);border-radius:8px;background:var(--wbm-surface);color:var(--wbm-fg);font:inherit;font-size:13px}
.wbm-input:focus{outline:2px solid var(--wbm-fg);outline-offset:-1px}
textarea.wbm-input{height:auto;min-height:64px;padding:7px 10px;resize:vertical;font-size:12px}
.wbm-field{display:grid;grid-template-columns:96px minmax(0,1fr);align-items:start;column-gap:16px;row-gap:6px}
.wbm-field-label{padding-top:5px;color:var(--wbm-fg2)}
.wbm-field-body{display:flex;flex-direction:column;gap:6px;min-width:0}
.wbm-seg{display:inline-flex;align-self:flex-start;max-width:100%;padding:2px;border-radius:9px;background:var(--wbm-sunken)}
.wbm-seg button{flex:1 1 auto;height:26px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--wbm-fg2);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.wbm-seg button:hover{color:var(--wbm-fg)}
.wbm-seg button[aria-pressed="true"]{background:var(--wbm-surface);color:var(--wbm-fg);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 .5px var(--wbm-line)}
.wbm-seg button:disabled{cursor:default}
.wbm-hint{color:var(--wbm-fg3);font-size:12px;line-height:18px}
.wbm-link{display:block;min-width:0;padding:7px 10px;border-radius:8px;background:var(--wbm-sunken);color:var(--wbm-fg);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:none}
.wbm-link:hover{text-decoration:underline}
.wbm-statusline{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;color:var(--wbm-fg3);font-size:12px}
.wbm-mono{font-size:12px;color:var(--wbm-fg2);overflow-wrap:anywhere}
.wbm-ok-text{color:var(--wbm-fg);font-weight:500}
.wbm-pinned{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.wbm-pinned li{display:flex;align-items:baseline;gap:8px;min-width:0}
.wbm-pinned li span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.wbm-pinned li span:last-child{color:var(--wbm-fg3);font-size:12px;white-space:nowrap}
.wbm-sub{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--wbm-line-soft)}
.wbm-sub-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--wbm-fg2);font-size:12px;font-weight:500}
.wbm-sub-toggle{width:100%;padding:0;border:0;background:transparent;font:inherit;text-align:left;cursor:pointer;color:var(--wbm-fg2)}
.wbm-sub-head>.wbm-sub-toggle{width:auto;flex:1 1 auto;min-width:0}
.wbm-sub-toggle:hover{color:var(--wbm-fg)}
.wbm-sub-toggle .wbm-chevron{transition:transform .15s ease;color:var(--wbm-fg3)}
.wbm-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer}
.wbm-check-input{accent-color:var(--wbm-primary);width:14px;height:14px;margin:3px 0 0;flex:0 0 auto;cursor:pointer}
.wbm-hint svg,.wbm-statusline svg{vertical-align:-2px}
.wbm-check-input:disabled{cursor:default}
.wbm-card{overflow:visible;border:1px solid var(--wbm-line,var(--dsw-alias-border-l2));border-radius:10px;background:var(--dsw-alias-bg-module-platform);list-style:none}
.wbm-card-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 14px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.wbm-card-head span{display:flex;flex-direction:column;gap:3px;min-width:0}
.wbm-card-head b{font-size:14px;line-height:20px;font-weight:600}
.wbm-card-head small{font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.wbm-card-head svg{flex:0 0 auto;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.wbm-card-body{border-top:1px solid var(--dsw-alias-border-l2);padding:16px 14px 18px}
.wbm-toast{box-sizing:border-box;position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 32px));padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:0 12px 32px rgba(0,0,0,.16);font-size:13px;line-height:20px}
.wbm-toast-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}
@container wbm (max-width:520px){
.wbm-row{grid-template-columns:7px minmax(0,1fr) auto}
.wbm-row-side .wbm-credit{display:none}
.wbm-field{grid-template-columns:minmax(0,1fr)}
.wbm-field-label{padding-top:0}
.wbm-seg{display:flex;align-self:stretch;width:100%}
.wbm-seg button{padding:0 6px}
}
`;

		/** Install the scoped stylesheet once per document; keyed so a re-mount never stacks tags. */
		function ensureUiCss() {
			if (typeof document === "undefined" || document === null || typeof document.querySelector !== "function") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(UI_CSS_TAG)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-workbuddy-multi";
			tag.dataset.pluginCss = UI_CSS_TAG;
			tag.textContent = UI_CSS;
			document.head.appendChild(tag);
		}

		/**
		 * The composer chip carrying the merged group's credit total.
		 *
		 * Same register as upstream's own credit line — 11px, dim, no pill — because it
		 * *replaces* that line rather than sitting beside it. The composer row measures
		 * its children and, when they no longer fit, sets `data-model-compact` on itself,
		 * which hides the model name. A wider control here silently costs the user the
		 * model name, so this one must not grow the row.
		 */
		const chipStyle = {
			display: "inline-flex",
			position: "relative",
			alignItems: "center",
			transform: "translateY(2px)",
			whiteSpace: "nowrap"
		};
		/** The chip's label; `title` carries the per-account tooltip. */
		const chipTextStyle = {
			fontSize: 11,
			lineHeight: "16px",
			color: "var(--dsw-alias-label-tertiary)",
			whiteSpace: "nowrap",
			padding: "0 4px 0 0",
			cursor: "help"
		};
		/** The chip's ↻, in upstream's icon-button register. */
		const chipButtonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 20,
			height: 20,
			padding: 0,
			border: 0,
			borderRadius: 6,
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			cursor: "pointer",
			fontSize: 11,
			lineHeight: 1
		};
		/**
		 * Styles that retire upstream's single-account credit line while our total is
		 * on screen.
		 *
		 * Upstream renders `[↻][number][推理等级]` inside one wrapper span, and the
		 * number is the *active* account's — the thing our total replaces. There is no
		 * API to remove one child of another plugin's contribution, so the selector
		 * anchors on that exact shape: a ↻ button whose `aria-label` is upstream's own
		 * refresh label, immediately followed by the number span.
		 *
		 * - Our own ↻ must NOT reuse upstream's label, or this rule would hide us too.
		 * - If upstream renames that label the rule stops matching: the user sees two
		 *   numbers again, and nothing else breaks.
		 * - It is scoped to `data-workbuddy-multi-merged`, set only while our chip is
		 *   mounted, so per-account mode keeps upstream's number.
		 */
		const CREDITS_CSS_TAG = "dsh-workbuddy-multi/credits.css";
		const CREDITS_CSS = [
			':root[data-workbuddy-multi-merged="1"] span:has(> button[aria-label="刷新积分"] + span) > button[aria-label="刷新积分"],',
			':root[data-workbuddy-multi-merged="1"] span:has(> button[aria-label="刷新积分"] + span) > button[aria-label="刷新积分"] + span,',
			':root[data-workbuddy-multi-merged="1"] span:has(> button[aria-label="Refresh credit balance"] + span) > button[aria-label="Refresh credit balance"],',
			':root[data-workbuddy-multi-merged="1"] span:has(> button[aria-label="Refresh credit balance"] + span) > button[aria-label="Refresh credit balance"] + span {',
			"	display: none !important;",
			"}"
		].join("\n");
		/** Install the rule once per document; keyed so a re-mount never stacks tags. */
		function ensureCreditsCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CREDITS_CSS_TAG)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-workbuddy-multi";
			tag.dataset.pluginCss = CREDITS_CSS_TAG;
			tag.textContent = CREDITS_CSS;
			document.head.appendChild(tag);
		}
		/** Mounts currently showing a merged total; the marker lives while at least one does. */
		let mergedMounts = 0;
		/**
		 * Mark the document while a merged total is on screen, so the CSS above only
		 * applies in the mode it was written for. Counted, because the slot is rendered
		 * once per conversation and several can be mounted at the same time.
		 */
		function useMergedMarker(active) {
			react.useEffect(() => {
				if (active !== true) return void 0;
				if (typeof document === "undefined") return void 0;
				mergedMounts += 1;
				document.documentElement.dataset.workbuddyMultiMerged = "1";
				return () => {
					mergedMounts = Math.max(0, mergedMounts - 1);
					if (mergedMounts === 0) delete document.documentElement.dataset.workbuddyMultiMerged;
				};
			}, [active]);
		}
		//#endregion

		//#region src/upstream-gate.js
		/**
		 * The companion is useless without `dsh-workbuddy-connect`, and DSH has no way to
		 * declare "this plugin needs that plugin". So the browser half checks for it and,
		 * when it is missing, installs it through the plugin market the user already has.
		 *
		 * Detection is the upstream plugin's own status route: it exists exactly when the
		 * upstream plugin is loaded. A 404 covers all three real cases at once — never
		 * installed, installed only as a library (pnpm auto-installed peer, not in the
		 * profile's bundle list), and installed but switched off.
		 *
		 * The market's install route only accepts URLs from its curated registry, and the
		 * upstream plugin is listed there under its GitHub URL, which is what we send.
		 * When the market is absent we cannot install anything, and say how to do it.
		 */
		const UPSTREAM_PACKAGE = "dsh-workbuddy-connect";
		const UPSTREAM_REPO_URL = "https://github.com/corrinehu/dsh-workbuddy-connect";
		const UPSTREAM_STATUS_PATH = "/plugins/dsh-workbuddy-connect/status";
		const MARKET_CAPABILITIES_PATH = "/dsh-market/api/v1/capabilities";
		const MARKET_INSTALLED_PATH = "/dsh-market/installed";
		const MARKET_INSTALL_PATH = "/dsh-market/install";
		const MARKET_TOGGLE_PATH = "/dsh-market/toggle";
		/** After a failed automatic attempt, wait this long before trying again on its own. */
		const UPSTREAM_AUTO_BACKOFF_MS = 6 * 3600000;
		const UPSTREAM_AUTO_KEY = "dsh-workbuddy-multi:upstream-auto-failed-at";

		/** How long after page load the dependency check runs. */
		const UPSTREAM_CHECK_DELAY_MS = 4000;

		/**
		 * After the market reports success, how long to keep probing for the dependency
		 * to come up. A hot install loads it within seconds; until then its status route
		 * still answers 404, and reading that as "missing" would install it a second time.
		 */
		const UPSTREAM_SETTLE_MS = 60000;
		const UPSTREAM_SETTLE_POLL_MS = 2000;

		/**
		 * The page-wide gate lives on `globalThis`, not in this module. Installing the
		 * dependency makes the host re-run this plugin's client module (hot reload); a
		 * fresh module-level gate would forget the install it just did and start another.
		 */
		const UPSTREAM_GATE_GLOBAL = Symbol.for("dsh-workbuddy-multi:upstream-gate");

		/** Phases that mean "the user has to see this". */
		const GATE_VISIBLE = new Set(["missing", "installing", "enabling", "installed", "needs-restart", "failed", "no-market"]);

		function readBackoff() {
			try {
				const raw = window.localStorage?.getItem(UPSTREAM_AUTO_KEY);
				const at = raw === null || raw === void 0 ? NaN : Number(raw);
				return Number.isFinite(at) ? at : void 0;
			} catch {
				return void 0;
			}
		}
		function writeBackoff(value) {
			try {
				if (value === void 0) window.localStorage?.removeItem(UPSTREAM_AUTO_KEY);
				else window.localStorage?.setItem(UPSTREAM_AUTO_KEY, String(value));
			} catch {
				/* storage is a convenience; without it we simply retry next page load */
			}
		}

		async function readJson(response) {
			try {
				return await response.json();
			} catch {
				return void 0;
			}
		}

		/**
		 * A tiny observable controller. One per page: the card, the plugin page and the
		 * page-load check all share it, so the install runs at most once at a time and
		 * every surface shows the same progress.
		 */
		function createUpstreamGate({ settleMs = UPSTREAM_SETTLE_MS, pollMs = UPSTREAM_SETTLE_POLL_MS } = {}) {
			let snapshot = { phase: "unknown" };
			const listeners = new Set();
			let running;
			let autoTried = false;

			const set = (next) => {
				snapshot = next;
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						/* one broken subscriber must not stop the others */
					}
				}
			};
			const request = (path, init) => fetch(path, {
				credentials: "same-origin",
				...init,
				headers: { accept: "application/json", ...(init?.headers ?? {}) }
			});
			const post = (path, body) => request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body)
			});

			/** `missing` on a 404 only; anything else (network blip, 5xx) is not evidence. */
			async function probe() {
				try {
					const response = await request(UPSTREAM_STATUS_PATH);
					return response.status === 404 ? "missing" : "present";
				} catch {
					return "unknown";
				}
			}

			const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

			/** Probe until the dependency answers, or `settleMs` runs out. */
			async function waitForPresent() {
				const until = Date.now() + settleMs;
				for (;;) {
					if (await probe() === "present") return true;
					if (Date.now() >= until) return false;
					await sleep(pollMs);
				}
			}

			async function install() {
				const caps = await request(MARKET_CAPABILITIES_PATH).catch(() => void 0);
				if (caps === void 0 || !caps.ok) {
					set({ phase: "no-market" });
					return false;
				}
				const listing = await request(MARKET_INSTALLED_PATH).catch(() => void 0);
				const installed = listing !== void 0 && listing.ok ? (await readJson(listing))?.installed : void 0;
				const present = installed !== null && typeof installed === "object" && Object.hasOwn(installed, UPSTREAM_PACKAGE);
				set({ phase: present ? "enabling" : "installing" });
				const response = present
					? await post(MARKET_TOGGLE_PATH, { name: UPSTREAM_PACKAGE, enabled: true })
					: await post(MARKET_INSTALL_PATH, { url: UPSTREAM_REPO_URL });
				const body = await readJson(response);
				// 409：市场里已有一个安装在跑（另一个标签页、用户手动点了安装，或本插件热重载前发起的那次）。
				// 那次安装会把依赖装上，这里等它出现即可，不算失败。
				if (response.status === 409) {
					const appeared = await waitForPresent();
					set({ phase: appeared ? "installed" : "needs-restart" });
					return true;
				}
				if (!response.ok || (body !== null && typeof body === "object" && body.ok === false)) {
					const reason = body !== null && typeof body === "object" && typeof body.error === "string" && body.error !== ""
						? body.error
						: `HTTP ${response.status}`;
					set({ phase: "failed", error: reason });
					return false;
				}
				const appeared = await waitForPresent();
				set({ phase: appeared ? "installed" : "needs-restart" });
				return true;
			}

			/**
			 * Check, and install when missing.
			 *
			 * `auto` is the page-load path: it runs at most once per page and stays quiet
			 * for a while after a failure, so a persistent problem (offline, market
			 * refusing) does not turn every page load into a package-manager run.
			 */
			function ensure({ auto = false } = {}) {
				if (running !== void 0) return running;
				if (auto) {
					if (autoTried) return Promise.resolve(snapshot);
					autoTried = true;
				}
				running = (async () => {
					try {
						if (snapshot.phase !== "installed" && snapshot.phase !== "needs-restart") set({ phase: "checking" });
						const found = await probe();
						if (found !== "missing") {
							if (snapshot.phase === "checking") set({ phase: found });
							return snapshot;
						}
						if (auto) {
							const failedAt = readBackoff();
							if (failedAt !== void 0 && Date.now() - failedAt < UPSTREAM_AUTO_BACKOFF_MS) {
								set({ phase: "missing" });
								return snapshot;
							}
						}
						const ok = await install();
						// 只有真的尝试过安装而失败才退避；没有插件市场时什么都没做，下次照常检查。
						writeBackoff(ok ? void 0 : snapshot.phase === "failed" ? Date.now() : void 0);
						return snapshot;
					} catch (error) {
						set({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
						writeBackoff(Date.now());
						return snapshot;
					} finally {
						running = void 0;
					}
				})();
				return running;
			}

			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				ensure
			};
		}

		const upstreamGate = globalThis[UPSTREAM_GATE_GLOBAL] ??= createUpstreamGate();

		/**
		 * How many in-card banners are on screen. While one is, the page-level notice
		 * stays hidden — the same message twice on one screen is noise.
		 */
		let bannerMounts = 0;
		const bannerListeners = new Set();
		function setBannerMounted(delta) {
			bannerMounts = Math.max(0, bannerMounts + delta);
			for (const listener of [...bannerListeners]) listener();
		}

		function useUpstreamGate() {
			const subscribe = react.useCallback((listener) => upstreamGate.subscribe(listener), []);
			const snapshot = react.useCallback(() => upstreamGate.getSnapshot(), []);
			return react.useSyncExternalStore(subscribe, snapshot, snapshot);
		}

		/** Copy for a gate phase, shared by the in-card banner and the page-load toast. */
		function gateMessage(state, t) {
			switch (state.phase) {
				case "installing": return t("upstreamInstalling");
				case "enabling": return t("upstreamEnabling");
				case "installed": return t("upstreamInstalled");
				case "needs-restart": return t("upstreamNeedsRestart");
				case "failed": return t("upstreamFailed", { error: state.error ?? "" });
				case "no-market": return t("upstreamNoMarket");
				default: return t("upstreamBody");
			}
		}

		/**
		 * The page-load notice. Plain DOM rather than React: it has to appear on any page,
		 * not just inside our settings card, and owns nothing but one element.
		 */
		function startUpstreamToast(t) {
			if (typeof document === "undefined" || document === null || typeof document.createElement !== "function") return () => void 0;
			let element;
			const remove = () => {
				element?.remove();
				element = void 0;
			};
			const render = () => {
				const state = upstreamGate.getSnapshot();
				if (!GATE_VISIBLE.has(state.phase) || bannerMounts > 0) {
					remove();
					return;
				}
				if (element === void 0) {
					element = document.createElement("div");
					element.className = "wbm-toast";
					element.setAttribute("role", "status");
					document.body.appendChild(element);
				}
				element.replaceChildren();
				const head = document.createElement("div");
				head.className = "wbm-toast-head";
				const title = document.createElement("span");
				title.textContent = t("upstreamHeading");
				const close = document.createElement("button");
				close.type = "button";
				close.className = "wbm-icon";
				close.setAttribute("aria-label", t("loginClose"));
				close.textContent = "×";
				close.addEventListener("click", remove);
				head.append(title, close);
				const body = document.createElement("div");
				body.textContent = gateMessage(state, t);
				element.append(head, body);
				if (state.phase === "no-market") {
					const code = document.createElement("code");
					code.className = "wbm-code";
					code.textContent = `dsh plugin add ${UPSTREAM_PACKAGE}`;
					element.append(code);
				}
				if (state.phase === "missing" || state.phase === "failed") {
					const install = document.createElement("button");
					install.type = "button";
					install.className = "wbm-btn wbm-btn--primary";
					install.textContent = state.phase === "failed" ? t("upstreamRetry") : t("upstreamInstall");
					install.addEventListener("click", () => void upstreamGate.ensure());
					element.append(install);
				}
				if (state.phase === "installed") {
					const reload = document.createElement("button");
					reload.type = "button";
					reload.className = "wbm-btn wbm-btn--primary";
					reload.textContent = t("upstreamReload");
					reload.addEventListener("click", () => window.location.reload());
					element.append(reload);
				}
			};
			const off = upstreamGate.subscribe(render);
			bannerListeners.add(render);
			// 热重载后接手的是一个已在进行中的安装：立即按当前状态显示，而不是等下一次状态变化
			render();
			return () => {
				off();
				bannerListeners.delete(render);
				remove();
			};
		}
		//#endregion

		//#region src/use-host-status.js
		/**
		 * Read the host status document, and expose one `run` that posts a frozen action
		 * and then re-reads.
		 *
		 *   - a non-document body is a failed read, not a document to store;
		 *   - a failed read never discards a document already on screen — it is recorded
		 *     beside it, and only becomes the rendered state when nothing was read yet;
		 *   - a write's own response is never the new truth: the re-read is.
		 *
		 * `pollMs` exists for the composer chip, which must not poll faster than the
		 * host's credit TTL (see `CREDITS_POLL_MS`).
		 */
		function useHostStatus(active, pollMs) {
			const interval = typeof pollMs === "number" && Number.isFinite(pollMs) && pollMs > 0 ? pollMs : POLL_INTERVAL_MS;
			const [status, setStatus] = react.useState(void 0);
			const [readFailure, setReadFailure] = react.useState(void 0);
			const [busy, setBusy] = react.useState(false);
			const mounted = react.useRef(true);
			const readSeq = react.useRef(0);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			const refresh = react.useCallback(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const value = await fetchStatus(signal);
					if (!current()) return false;
					setStatus(value);
					setReadFailure(void 0);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (current()) {
						setReadFailure(message);
						/*
						 * The host's not-ready `503` carries a status shell. Adopt it only when
						 * there is nothing to overwrite, so a real document is never downgraded
						 * to an empty one.
						 */
						const shell = error?.status;
						if (isStatusDocument(shell)) {
							setStatus((previous) => (isStatusDocument(previous) ? previous : shell));
						}
					}
					return false;
				}
			}, []);

			/**
			 * Post one frozen action, then re-read. A failed write is reported and the card
			 * keeps the document it has: the write may have succeeded on the host and failed
			 * on the way back, so re-reading is the only way to know what happened.
			 */
			const run = react.useCallback(async (action, parameters) => {
				setBusy(true);
				try {
					await postAction(action, parameters);
					await refresh();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (mounted.current) setReadFailure(message);
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [refresh]);

			react.useEffect(() => {
				if (!active) return;
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
				};
			}, [active, refresh]);

			react.useEffect(() => {
				if (!active) return;
				const timer = window.setInterval(() => {
					refresh();
				}, interval);
				return () => {
					window.clearInterval(timer);
				};
			}, [active, refresh, interval]);

			return { status, readFailure, busy, refresh, run };
		}
		//#endregion

		//#region src/components.js
		/** Stroke icons, drawn at 16px in `currentColor`. */
		const ICON_PATHS = {
			refresh: "M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 2.5v3h-3",
			more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
			chevron: "M4 6l4 4 4-4",
			close: "M4 4l8 8M12 4l-8 8"
		};
		function Icon({ name, spin }) {
			return jsx("svg", {
				viewBox: "0 0 16 16",
				/* 默认尺寸写在元素上：不带尺寸的 SVG 在普通文本/按钮上下文里会撑满整行。
				   已有尺寸规则的容器（.wbm-icon svg 等）是 CSS，优先级高于元素属性，不受影响。 */
				width: 16,
				height: 16,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: name === "more" ? 2.2 : 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				className: spin ? "wbm-spin" : void 0,
				children: jsx("path", { d: ICON_PATHS[name] })
			});
		}

		/** Join non-empty class names. */
		function cx(...names) {
			return names.filter((name) => typeof name === "string" && name !== "").join(" ");
		}

		/**
		 * The "⋯" menu that holds every secondary action, so a row shows one quiet control
		 * instead of five buttons. Closes on outside pointer-down and on Escape.
		 */
		function Menu({ items, label, disabled }) {
			const [open, setOpen] = react.useState(false);
			const box = react.useRef(null);
			react.useEffect(() => {
				if (!open || typeof document === "undefined" || document === null) return void 0;
				const onDown = (event) => {
					if (box.current !== null && typeof box.current.contains === "function" && !box.current.contains(event.target)) setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const visible = items.filter((item) => item !== null && item !== void 0 && item !== false);
			return jsxs("div", {
				className: "wbm-menu",
				ref: box,
				children: [
					jsx("button", {
						type: "button",
						className: "wbm-icon",
						"aria-label": label,
						"aria-haspopup": "menu",
						"aria-expanded": open,
						title: label,
						disabled,
						onClick: () => setOpen(!open),
						children: jsx(Icon, { name: "more" })
					}),
					open ? jsx("div", {
						className: "wbm-menu-pop",
						role: "menu",
						children: visible.map((item, index) => item.separator === true
							? jsx("div", { className: "wbm-menu-sep", role: "separator" }, `sep-${String(index)}`)
							: jsx("button", {
								type: "button",
								role: "menuitem",
								className: cx("wbm-menu-item", item.danger ? "wbm-menu-item--danger" : ""),
								disabled: item.disabled === true,
								onClick: () => {
									setOpen(false);
									item.onSelect();
								},
								children: item.label
							}, item.key))
					}) : null
				]
			});
		}

		/** A segmented control: one choice, every option visible, current one raised. */
		function Segmented({ options, value, onChange, disabled, label }) {
			return jsx("div", {
				className: "wbm-seg",
				role: "group",
				"aria-label": label,
				children: options.map((option) => jsx("button", {
					type: "button",
					"aria-pressed": option.id === value,
					disabled,
					onClick: () => {
						if (option.id !== value) onChange(option.id);
					},
					children: option.label
				}, option.id))
			});
		}

		function Tag({ text, tone }) {
			return jsx("span", { className: cx("wbm-tag", tone === void 0 ? "" : `wbm-tag--${tone}`), children: text });
		}

		/** The `{count}` summary shown in the collapsed card header. */
		function summarize(status, t) {
			if (status === void 0) return t("loading");
			const counts = { cn: 0, ai: 0 };
			for (const variant of arrayOf(status.variants)) {
				const accounts = arrayOf(variant.accounts);
				if (variant.key === "cn") counts.cn = accounts.length;
				else if (variant.key === "ai") counts.ai = accounts.length;
			}
			if (counts.cn + counts.ai === 0) return t("summaryEmpty");
			return t("summaryCounts", { cn: counts.cn, ai: counts.ai });
		}

		/** Non-finite / missing counters render as 0 rather than as `undefined`. */
		const countOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

		/** Compact local date-time: `HH:mm` today, `M/D HH:mm` otherwise. */
		function formatShort(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
			const date = new Date(ms);
			if (Number.isNaN(date.getTime())) return "—";
			const now = new Date();
			const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
			return sameDay ? formatClock(ms) : `${date.getMonth() + 1}/${date.getDate()} ${formatClock(ms)}`;
		}

		/**
		 * The top line: is anything still renewing tokens, and the two page-level actions.
		 *
		 * Keepalive sits here because a scheduler that died is silent — every account looks
		 * fine until they all expire at once. Its counters are a tooltip; only a failure
		 * becomes visible text.
		 */
		function StatusBar({ status, busy, refresh, loginOpen, onToggleLogin, t }) {
			const keepalive = status?.keepalive;
			const hasKeepalive = keepalive !== null && typeof keepalive === "object";
			const running = hasKeepalive && keepalive.running === true;
			const stats = hasKeepalive && keepalive.stats !== null && typeof keepalive.stats === "object" ? keepalive.stats : void 0;
			const failed = countOf(stats?.failed);
			const unavailable = hasKeepalive && typeof keepalive.unavailable === "string" && keepalive.unavailable !== "" ? keepalive.unavailable : void 0;
			const statsText = stats === void 0 ? void 0 : t("keepaliveStats", { ok: countOf(stats.ok), failed, skipped: countOf(stats.skipped) });
			return jsxs("div", {
				className: "wbm-bar",
				children: [
					hasKeepalive ? jsxs("div", {
						className: "wbm-bar-status",
						title: statsText,
						children: [
							jsx("span", { className: cx("wbm-dot", unavailable !== void 0 || failed > 0 ? "wbm-dot--warn" : running ? "wbm-dot--ok" : "wbm-dot--off") }),
							jsx("b", { children: t("keepaliveHeading") }),
							jsx("span", { children: running ? t("keepaliveRunning") : t("keepaliveStopped") }),
							jsx("span", {
								className: "wbm-muted",
								children: typeof keepalive.lastSweepAt === "number" ? t("keepaliveLastSweep", { time: formatShort(keepalive.lastSweepAt) }) : t("keepaliveNever")
							}),
							failed > 0 ? jsx("span", { className: "wbm-error", children: t("keepaliveFailed", { n: failed }) }) : null,
							unavailable !== void 0 ? jsx("span", { className: "wbm-error", children: t("keepaliveUnavailable", { reason: unavailable }) }) : null
						]
					}) : jsx("div", { className: "wbm-bar-status", children: summarize(status, t) }),
					jsxs("div", {
						className: "wbm-bar-actions",
						children: [
							jsx("button", {
								type: "button",
								className: cx("wbm-btn", loginOpen ? "" : "wbm-btn--primary"),
								"aria-expanded": loginOpen,
								onClick: onToggleLogin,
								children: t("loginHeading")
							}),
							jsx("button", {
								type: "button",
								className: "wbm-icon",
								"aria-label": busy ? t("refreshing") : t("refresh"),
								title: t("refresh"),
								disabled: busy,
								onClick: () => refresh(),
								children: jsx(Icon, { name: "refresh", spin: busy })
							})
						]
					})
				]
			});
		}

		/** Upstream-missing banner: what is happening, and the one thing to do next. */
		function UpstreamBanner({ t }) {
			const state = useUpstreamGate();
			react.useEffect(() => {
				setBannerMounted(1);
				void upstreamGate.ensure({ auto: true });
				return () => setBannerMounted(-1);
			}, []);
			if (!GATE_VISIBLE.has(state.phase)) return null;
			const working = state.phase === "installing" || state.phase === "enabling";
			const tone = state.phase === "failed" ? "err" : state.phase === "installed" || state.phase === "needs-restart" ? "" : "warn";
			return jsxs("div", {
				className: cx("wbm-banner", tone === "" ? "" : `wbm-banner--${tone}`),
				role: "status",
				children: [
					jsxs("div", {
						className: "wbm-banner-title",
						children: [
							working ? jsx(Icon, { name: "refresh", spin: true }) : null,
							jsx("span", { children: t("upstreamHeading") })
						]
					}),
					jsx("p", { className: "wbm-banner-text", children: gateMessage(state, t) }),
					state.phase === "no-market" ? jsx("code", { className: "wbm-code", children: `dsh plugin add ${UPSTREAM_PACKAGE}` }) : null,
					state.phase === "missing" || state.phase === "failed" ? jsx("div", {
						className: "wbm-banner-actions",
						children: jsx("button", {
							type: "button",
							className: "wbm-btn wbm-btn--primary",
							onClick: () => void upstreamGate.ensure(),
							children: state.phase === "failed" ? t("upstreamRetry") : t("upstreamInstall")
						})
					}) : null,
					state.phase === "installed" ? jsx("div", {
						className: "wbm-banner-actions",
						children: jsx("button", {
							type: "button",
							className: "wbm-btn wbm-btn--primary",
							onClick: () => window.location.reload(),
							children: t("upstreamReload")
						})
					}) : null
				]
			});
		}

		/** Things only the user can fix. Empty → nothing rendered at all. */
		function AttentionBanner({ warnings, t }) {
			const list = arrayOf(warnings).map(String).filter((text) => text !== "");
			if (list.length === 0) return null;
			return jsxs("div", {
				className: "wbm-banner wbm-banner--warn",
				role: "alert",
				children: [
					jsx("div", { className: "wbm-banner-title", children: t("warningsHeading") }),
					list.length === 1
						? jsx("p", { className: "wbm-banner-text", children: list[0] })
						: jsx("ul", { children: list.map((text, index) => jsx("li", { children: text }, `w-${String(index)}`)) })
				]
			});
		}

		/** The inline rename form for one account. */
		function RenameForm({ initial, busy, onSubmit, onCancel, t }) {
			const [value, setValue] = react.useState(initial ?? "");
			return jsxs("div", {
				className: "wbm-panel wbm-panel--sunken wbm-row-panel",
				children: [
					jsx("input", {
						type: "text",
						className: "wbm-input",
						value,
						placeholder: t("renamePlaceholder"),
						"aria-label": t("renamePlaceholder"),
						onChange: (event) => setValue(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter" && value.trim() !== "") onSubmit(value.trim());
							if (event.key === "Escape") onCancel();
						}
					}),
					jsxs("div", {
						className: "wbm-actions",
						children: [
							jsx("button", {
								type: "button",
								className: "wbm-btn wbm-btn--primary wbm-btn--sm",
								disabled: busy,
								onClick: () => {
									const next = value.trim();
									if (next !== "") onSubmit(next);
								},
								children: t("renameSubmit")
							}),
							jsx("button", { type: "button", className: "wbm-btn wbm-btn--quiet wbm-btn--sm", onClick: onCancel, children: t("renameCancel") })
						]
					})
				]
			});
		}

		/** The inline delete confirmation for one account. */
		function RemoveConfirm({ label, busy, onConfirm, onCancel, t }) {
			return jsxs("div", {
				className: "wbm-panel wbm-panel--sunken wbm-row-panel",
				children: [
					jsx("p", { children: t("removeConfirm", { label }) }),
					jsxs("div", {
						className: "wbm-actions",
						children: [
							jsx("button", { type: "button", className: "wbm-btn wbm-btn--danger wbm-btn--sm", disabled: busy, onClick: onConfirm, children: t("confirmYes") }),
							jsx("button", { type: "button", className: "wbm-btn wbm-btn--quiet wbm-btn--sm", onClick: onCancel, children: t("confirmNo") })
						]
					})
				]
			});
		}

		/** The inline import form for one edition. */
		function ImportForm({ busy, onSubmit, onCancel, t }) {
			const [value, setValue] = react.useState("");
			const [error, setError] = react.useState(void 0);
			return jsxs("div", {
				className: "wbm-panel",
				children: [
					jsxs("div", {
						className: "wbm-panel-head",
						children: [
							jsx("b", { children: t("importHeading") }),
							jsx("button", { type: "button", className: "wbm-icon", "aria-label": t("importCancel"), onClick: onCancel, children: jsx(Icon, { name: "close" }) })
						]
					}),
					jsx("textarea", {
						className: "wbm-input",
						value,
						placeholder: t("importPlaceholder"),
						"aria-label": t("importHeading"),
						onChange: (event) => setValue(event.target.value)
					}),
					jsx("p", { className: "wbm-hint", children: t("importNote") }),
					error === void 0 ? null : jsx("p", { className: "wbm-error", children: error }),
					jsx("div", {
						className: "wbm-actions",
						children: jsx("button", {
							type: "button",
							className: "wbm-btn wbm-btn--primary wbm-btn--sm",
							disabled: busy,
							onClick: () => {
								const paths = value.split("\n").map((line) => line.trim()).filter((line) => line !== "");
								if (paths.length === 0) {
									setError(t("importEmpty"));
									return;
								}
								setError(void 0);
								onSubmit(paths);
							},
							children: t("importSubmit")
						})
					})
				]
			});
		}

		/** Show an account's token expiry only when it is this close. */
		const EXPIRY_NOTICE_MS = 6 * 3600000;

		/**
		 * The credit cell for one account: its number, or nothing. When the number cannot
		 * be computed the reason goes into the cell's tooltip, not into the row's text.
		 */
		function creditCellFor(aggregate, uid, t) {
			if (aggregate === void 0) return void 0;
			for (const row of arrayOf(aggregate.accounts)) {
				if (row === null || typeof row !== "object" || row.uid !== uid) continue;
				const known = row.unlimited === true || (typeof row.total === "number" && Number.isFinite(row.total));
				return known
					? { text: t("accountCredits", { n: creditAccountValue(row, t) }) }
					: { text: t("accountCreditsUnknown"), title: creditAccountValue(row, t) };
			}
			return void 0;
		}

		/**
		 * One account: a status dot, its name and state tags, one line of facts, and the
		 * actions. Only "use this" is a visible button; the rest live in the ⋯ menu.
		 */
		function AccountRow({ variant, account, aggregate, highlighted, busy, run, t }) {
			const [panel, setPanel] = react.useState(void 0);
			const uid = account.uid;
			const label = typeof account.label === "string" && account.label !== "" ? account.label : shortUid(uid);
			const isActive = variant.activeUid === uid;
			const enabled = account.enabled !== false;
			const until = cooldownUntil(variant, account);
			const cooling = typeof until === "number" && until > Date.now();
			const expired = typeof account.expiresAt === "number" && account.expiresAt <= Date.now();
			const relogin = account.needsRelogin === true;
			const dead = account.dead === true;

			const dot = relogin || dead ? "err" : cooling || expired ? "warn" : !enabled ? "off" : isActive ? "ok" : "";
			const tags = [];
			if (isActive) tags.push(jsx(Tag, { text: t("accountActive"), tone: "strong" }, "active"));
			if (highlighted) tags.push(jsx(Tag, { text: t("accountJustAdded") }, "fresh"));
			if (relogin) tags.push(jsx(Tag, { text: t("accountNeedsRelogin"), tone: "err" }, "relogin"));
			if (dead) tags.push(jsx(Tag, { text: t("accountDead"), tone: "err" }, "dead"));
			if (!enabled) tags.push(jsx(Tag, { text: t("accountDisabled") }, "disabled"));
			if (cooling) tags.push(jsx(Tag, { text: t("accountCooling", { time: formatShort(until) }), tone: "warn" }, "cooling"));
			if (expired) tags.push(jsx(Tag, { text: t("accountExpired"), tone: "warn" }, "expired"));

			const facts = [];
			const sourceKey = typeof account.source === "string" ? SOURCE_LABEL_KEYS[account.source] : void 0;
			if (sourceKey !== void 0) facts.push(t(sourceKey));
			// 令牌会自动续期，离到期还早时这条信息没有用；只在快到期时提一句。
			if (typeof account.expiresAt === "number" && account.expiresAt - Date.now() < EXPIRY_NOTICE_MS) {
				const remaining = describeRemaining(account.expiresAt, t);
				if (remaining !== void 0) facts.push(remaining);
			}
			facts.push(typeof account.lastUsedAt === "number" ? t("accountLastUsed", { time: formatShort(account.lastUsedAt) }) : t("accountNeverUsed"));

			const credit = creditCellFor(aggregate, uid, t);
			// 冷却中、需重新登录的账号设为当前只会立刻再失败一次，不给这个入口。
			const canSelect = !isActive && enabled && !dead && !cooling && !relogin;

			return jsxs("li", {
				className: cx("wbm-row", !enabled ? "wbm-row--off" : "", highlighted ? "wbm-row--fresh" : ""),
				children: [
					jsx("span", { className: cx("wbm-dot", dot === "" ? "" : `wbm-dot--${dot}`), "aria-hidden": "true" }),
					jsxs("div", {
						className: "wbm-row-main",
						children: [
							jsxs("div", {
								className: "wbm-row-title",
								children: [jsx("span", { className: "wbm-name", title: uid, children: label }), ...tags]
							}),
							jsx("span", { className: "wbm-meta", children: facts.join(" · ") }),
							relogin && typeof account.needsReloginReason === "string" && account.needsReloginReason !== ""
								? jsx("span", { className: "wbm-note wbm-note--warn", children: t("accountNeedsReloginReason", { reason: account.needsReloginReason }) })
								: null,
							typeof account.lastRefreshError === "string" && account.lastRefreshError !== ""
								? jsx("span", { className: "wbm-note wbm-note--err", children: t("accountLastRefreshError", { error: account.lastRefreshError }) })
								: null
						]
					}),
					jsxs("div", {
						className: "wbm-row-side",
						children: [
							credit === void 0 ? null : jsx("span", { className: "wbm-credit", title: credit.title, children: credit.text }),
							canSelect ? jsx("button", {
								type: "button",
								className: "wbm-btn wbm-btn--sm",
								disabled: busy,
								onClick: () => run(ACTIONS.select, { variantKey: variant.key, uid }),
								children: t("actionSelect")
							}) : null,
							jsx(Menu, {
								label: t("more"),
								items: [
									{ key: "refresh", label: t("actionRefreshAccount"), disabled: busy, onSelect: () => run(ACTIONS.refreshAccount, { variantKey: variant.key, uid }) },
									{
										key: "toggle",
										label: enabled ? t("actionDisable") : t("actionEnable"),
										disabled: busy,
										onSelect: () => run(ACTIONS.setEnabled, { variantKey: variant.key, uid, on: !enabled })
									},
									{ key: "rename", label: t("actionRename"), onSelect: () => setPanel("rename") },
									{ separator: true },
									{ key: "remove", label: t("actionRemove"), danger: true, onSelect: () => setPanel("remove") }
								]
							})
						]
					}),
					panel === "rename" ? jsx(RenameForm, {
						initial: label,
						busy,
						onSubmit: (next) => {
							setPanel(void 0);
							run(ACTIONS.setLabel, { variantKey: variant.key, uid, label: next });
						},
						onCancel: () => setPanel(void 0),
						t
					}) : null,
					panel === "remove" ? jsx(RemoveConfirm, {
						label,
						busy,
						onConfirm: () => {
							setPanel(void 0);
							run(ACTIONS.remove, { variantKey: variant.key, uid });
						},
						onCancel: () => setPanel(void 0),
						t
					}) : null
				]
			}, `${variant.key}:${uid}`);
		}

		/** The edition's total credits, phrased honestly when only some accounts answered. */
		function variantCreditText(aggregate, t) {
			const total = formatCreditTotal(aggregate);
			if (total === void 0) return void 0;
			if (aggregate.complete === false) {
				return t("variantCreditsPartial", { total, ready: countOf(aggregate.readyCount), count: countOf(aggregate.accountCount) });
			}
			return t("variantCredits", { total });
		}

		/** One edition: heading, its menu, and the account list. */
		function VariantSection({ variant, credits, highlightUid, busy, run, t }) {
			const [importing, setImporting] = react.useState(false);
			const accounts = arrayOf(variant.accounts);
			const aggregate = creditsFor(credits, variant.key);
			const creditText = variantCreditText(aggregate, t);
			const editionKey = variant.key === "cn" ? "variantCn" : variant.key === "ai" ? "variantAi" : void 0;
			const subtitle = [editionKey === void 0 ? void 0 : t(editionKey), creditText].filter((part) => part !== void 0).join(" · ");
			return jsxs("section", {
				className: "wbm-section",
				children: [
					jsxs("div", {
						className: "wbm-section-head",
						children: [
							jsxs("div", {
								className: "wbm-section-title",
								children: [
									jsx("h3", { children: variant.displayName ?? variant.key }),
									subtitle === "" ? null : jsx("span", { children: subtitle })
								]
							}),
							jsx(Menu, {
								label: t("more"),
								items: [
									{ key: "capture", label: t("actionCapture"), disabled: busy, onSelect: () => run(ACTIONS.refreshFromDesktop, { variantKey: variant.key }) },
									{ key: "import", label: t("actionImport"), onSelect: () => setImporting(true) },
									accounts.length > 1 ? { key: "advance", label: t("actionAdvance"), disabled: busy, onSelect: () => run(ACTIONS.advance, { variantKey: variant.key }) } : null,
									accounts.length > 0 ? { separator: true } : null,
									accounts.length > 0 ? { key: "credits", label: t("creditsRefresh"), disabled: busy, onSelect: () => run(ACTIONS.refreshCredits, { variantKey: variant.key, force: true }) } : null
								]
							})
						]
					}),
					importing ? jsx(ImportForm, {
						busy,
						onSubmit: (paths) => {
							setImporting(false);
							run(ACTIONS.importPaths, { variantKey: variant.key, paths });
						},
						onCancel: () => setImporting(false),
						t
					}) : null,
					accounts.length === 0 ? jsx("div", {
						className: "wbm-list",
						children: jsxs("div", {
							className: "wbm-empty",
							children: [jsx("b", { children: t("noAccounts") }), jsx("span", { className: "wbm-hint", children: t("noAccountsHint") })]
						})
					}) : jsx("ul", {
						className: "wbm-list",
						children: accounts.map((account) => jsx(AccountRow, {
							variant,
							account,
							aggregate,
							highlighted: typeof highlightUid === "string" && highlightUid !== "" && account.uid === highlightUid,
							busy,
							run,
							t
						}, `${variant.key}:${account.uid}`))
					})
				]
			});
		}

		/** Rotation policy and model-group layout, as two segmented controls. */
		function SettingsSection({ status, busy, run, t }) {
			const policy = status.policy;
			const mode = status.groups?.mode;
			const policyOption = POLICIES.find((option) => option.id === policy);
			const modeOption = GROUP_MODES.find((option) => option.id === mode);
			const pinned = arrayOf(status.pinned);
			return jsxs("section", {
				className: "wbm-section",
				children: [
					jsx("div", { className: "wbm-section-head", children: jsx("div", { className: "wbm-section-title", children: jsx("h3", { children: t("settingsHeading") }) }) }),
					jsxs("div", {
						className: "wbm-panel",
						children: [
							jsxs("div", {
								className: "wbm-field",
								children: [
									jsx("span", { className: "wbm-field-label", children: t("policyHeading") }),
									jsxs("div", {
										className: "wbm-field-body",
										children: [
											jsx(Segmented, {
												label: t("policyHeading"),
												options: POLICIES.map((option) => ({ id: option.id, label: t(option.labelKey) })),
												value: policy,
												disabled: busy,
												onChange: (id) => run(ACTIONS.setPolicy, { policy: id })
											}),
											policyOption === void 0 ? null : jsx("p", { className: "wbm-hint", children: t(policyOption.hintKey) })
										]
									})
								]
							}),
							jsxs("div", {
								className: "wbm-field",
								children: [
									jsx("span", { className: "wbm-field-label", children: t("groupsHeading") }),
									jsxs("div", {
										className: "wbm-field-body",
										children: [
											jsx(Segmented, {
												label: t("groupsHeading"),
												options: GROUP_MODES.map((option) => ({ id: option.id, label: t(option.labelKey) })),
												value: mode,
												disabled: busy,
												onChange: (id) => {
													const option = GROUP_MODES.find((entry) => entry.id === id);
													if (option !== void 0) run(ACTIONS.setPinned, { on: option.on });
												}
											}),
											modeOption === void 0 ? null : jsx("p", { className: "wbm-hint", children: t(modeOption.hintKey) }),
											mode === "per-account" ? jsxs(Fragment, {
												children: [
													pinned.length === 0
														? jsx("p", { className: "wbm-hint", children: t("pinnedAccountEmpty") })
														: jsx("ul", {
															className: "wbm-pinned",
															"aria-label": t("pinnedHeading"),
															children: pinned.map((entry, index) => jsxs("li", {
																children: [
																	jsx("span", { children: entry.displayName ?? entry.providerId }),
																	jsx("span", { children: entry.providerId })
																]
															}, `${entry.providerId ?? "pinned"}-${String(index)}`))
														}),
													jsx("p", { className: "wbm-hint", children: t("pinnedPendingRestart") })
												]
											}) : null
										]
									})
								]
							}),
							jsxs("div", {
								className: "wbm-field",
								children: [
									jsx("span", { className: "wbm-field-label", children: t("reasoningHeading") }),
									jsxs("div", {
										className: "wbm-field-body",
										children: [
											jsx(Segmented, {
												label: t("reasoningHeading"),
												options: [
													{ id: "on", label: t("reasoningOn") },
													{ id: "off", label: t("reasoningOff") }
												],
												value: status.reasoning?.enabled === false ? "off" : "on",
												disabled: busy,
												onChange: (id) => run(ACTIONS.setReasoningCache, { on: id === "on" })
											}),
											(() => {
												const variants = status.reasoning?.variants;
												const count = (variants?.cn?.models?.length ?? 0) + (variants?.ai?.models?.length ?? 0);
												return count > 0 ? jsx("p", { className: "wbm-hint", children: t("reasoningCachedCount", { count }) }) : null;
											})()
										]
									})
								]
							}),
							jsxs("div", {
								className: "wbm-field",
								children: [
									jsx("span", { className: "wbm-field-label", children: t("chipHeading") }),
									jsxs("div", {
										className: "wbm-field-body",
										children: [
											jsx(Segmented, {
												label: t("chipHeading"),
												options: [
													{ id: "on", label: t("chipShow") },
													{ id: "off", label: t("chipHide") }
												],
												value: status.composerChip === false ? "off" : "on",
												disabled: busy,
												onChange: (id) => run(ACTIONS.setCreditsChip, { on: id === "on" })
											}),
											jsx("p", { className: "wbm-hint", children: t("chipHint") })
										]
									})
								]
							})
						]
					})
				]
			});
		}

		/**
		 * Add an account through WorkBuddy's official QR sign-in page.
		 *
		 * ── The one-timer rule ─────────────────────────────────────────────────────
		 * A waiting panel owns exactly ONE `setInterval`. That single timer advances the
		 * countdown every second AND fires the host poll on every second tick, so there
		 * is no second timer to forget. The timer's lifetime IS the effect's lifetime:
		 * closing the panel unmounts it, and nothing outlives the component.
		 *
		 * Closing an in-flight login deliberately does NOT post `loginCancel`: the host
		 * expires an abandoned login on its own, and closing a panel should not cause a
		 * network write. Only the explicit 取消 cancels.
		 *
		 * The server's status string (`11217:login ing...`) is shown verbatim: it is the
		 * only progress signal there is, and rewriting it would hide the difference
		 * between "still waiting" and "upstream said something unexpected".
		 */
		function LoginPanel({ t, onLanded, onClose }) {
			const [variantKey, setVariantKey] = react.useState(LOGIN_VARIANTS[0].key);
			const [login, setLogin] = react.useState(void 0);
			const [phase, setPhase] = react.useState("idle");
			const [serverStatus, setServerStatus] = react.useState(void 0);
			const [failure, setFailure] = react.useState(void 0);
			const [copied, setCopied] = react.useState(void 0);
			const [starting, setStarting] = react.useState(false);
			const [now, setNow] = react.useState(() => Date.now());

			const loginId = login === void 0 ? void 0 : login.loginId;
			const expiresAt = login === void 0 ? void 0 : login.expiresAt;

			react.useEffect(() => {
				if (phase !== "waiting" || loginId === void 0) return void 0;
				let ticks = 0;
				const handle = setInterval(() => {
					ticks += 1;
					const at = Date.now();
					setNow(at);
					if (expiresAt !== void 0 && at >= expiresAt) {
						setPhase("failed");
						setFailure(t("loginExpired"));
						return;
					}
					if (ticks % LOGIN_POLL_EVERY_TICKS !== 0) return;
					void poll();
				}, LOGIN_TICK_MS);
				return () => clearInterval(handle);
			}, [phase, loginId, expiresAt, t]);

			/** One poll of the host's `loginPoll`. Never throws. */
			async function poll() {
				try {
					const result = await postAction(ACTIONS.loginPoll, { loginId });
					if (result === null || typeof result !== "object") return;
					if (result.done !== true) {
						if (typeof result.status === "string" && result.status !== "") setServerStatus(result.status);
						return;
					}
					if (result.ok === true) {
						setPhase("done");
						onLanded(result.meta ?? void 0);
						return;
					}
					setPhase("failed");
					setFailure(typeof result.error === "string" && result.error !== "" ? result.error : t("loginFailed"));
				} catch (error) {
					/* A transport failure is not a verdict: the link may still be scannable. */
					setServerStatus(error instanceof Error ? error.message : String(error));
				}
			}

			async function start() {
				setStarting(true);
				setFailure(void 0);
				setServerStatus(void 0);
				setCopied(void 0);
				try {
					const result = await postAction(ACTIONS.loginStart, { variantKey });
					const id = result !== null && typeof result === "object" ? result.loginId : void 0;
					const uri = result !== null && typeof result === "object" ? result.verificationUri : void 0;
					if (typeof id !== "string" || id === "" || typeof uri !== "string" || uri === "") {
						setPhase("failed");
						setFailure(t("loginFailed"));
						return;
					}
					const startedAt = Date.now();
					setLogin({ loginId: id, verificationUri: uri, variantKey, expiresAt: startedAt + normalizeExpiresIn(result.expiresIn) });
					setNow(startedAt);
					setPhase("waiting");
				} catch (error) {
					setPhase("failed");
					setFailure(error instanceof Error ? error.message : String(error));
				} finally {
					setStarting(false);
				}
			}

			async function copyLink() {
				try {
					await navigator.clipboard.writeText(login.verificationUri);
					setCopied(true);
				} catch {
					setCopied(false);
				}
			}

			async function cancel() {
				const id = loginId;
				/* Flip the phase first so the timer stops immediately. */
				setPhase("cancelled");
				if (id === void 0) return;
				try {
					await postAction(ACTIONS.loginCancel, { loginId: id });
				} catch {
					/* Best effort: the host expires an abandoned login anyway. */
				}
			}

			function reset() {
				setLogin(void 0);
				setPhase("idle");
				setServerStatus(void 0);
				setFailure(void 0);
			}

			const waiting = phase === "waiting" && login !== void 0;
			const idle = phase === "idle" || phase === "failed" || phase === "cancelled";

			return jsxs("div", {
				className: "wbm-panel",
				children: [
					jsxs("div", {
						className: "wbm-panel-head",
						children: [
							jsx("b", { children: t("loginHeading") }),
							jsx("button", { type: "button", className: "wbm-icon", "aria-label": t("loginClose"), title: t("loginClose"), onClick: onClose, children: jsx(Icon, { name: "close" }) })
						]
					}),

					idle ? jsxs(Fragment, {
						children: [
							jsxs("div", {
								className: "wbm-field",
								children: [
									jsx("span", { className: "wbm-field-label", children: t("loginChoose") }),
									jsx("div", {
										className: "wbm-field-body",
										children: jsx(Segmented, {
											label: t("loginChoose"),
											options: LOGIN_VARIANTS.map((option) => ({ id: option.key, label: t(option.labelKey) })),
											value: variantKey,
											disabled: starting,
											onChange: (id) => setVariantKey(id)
										})
									})
								]
							}),
							phase === "failed" && failure !== void 0 ? jsx("p", { className: "wbm-error", children: `${t("loginFailed")}：${failure}` }) : null,
							phase === "cancelled" ? jsx("p", { className: "wbm-muted", children: t("loginCancelled") }) : null,
							jsx("div", {
								className: "wbm-actions",
								children: jsx("button", {
									type: "button",
									className: "wbm-btn wbm-btn--primary",
									disabled: starting,
									onClick: () => start(),
									children: starting ? t("loginStarting") : (phase === "idle" ? t("loginStart") : t("loginRetry"))
								})
							})
						]
					}) : null,

					waiting ? jsxs(Fragment, {
						children: [
							jsx("a", {
								href: login.verificationUri,
								target: "_blank",
								rel: "noreferrer",
								className: "wbm-link",
								title: login.verificationUri,
								children: login.verificationUri
							}),
							jsxs("div", {
								className: "wbm-actions",
								children: [
									jsx("a", {
										href: login.verificationUri,
										target: "_blank",
										rel: "noreferrer",
										className: "wbm-btn wbm-btn--primary",
										children: t("loginOpen")
									}),
									jsx("button", { type: "button", className: "wbm-btn", onClick: () => copyLink(), children: copied === true ? t("loginCopied") : t("loginCopy") }),
									jsx("button", { type: "button", className: "wbm-btn wbm-btn--quiet", onClick: () => cancel(), children: t("loginCancel") })
								]
							}),
							copied === false ? jsx("p", { className: "wbm-error", children: t("loginCopyFailed") }) : null,
							jsxs("div", {
								className: "wbm-statusline",
								children: [
									jsx("span", { children: t("loginCountdown", { time: formatCountdown(expiresAt - now) }) }),
									jsx(Icon, { name: "refresh", spin: true }),
									jsx("span", { className: "wbm-mono", children: serverStatus ?? t(LOGIN_VARIANTS.find((v) => v.key === login.variantKey)?.waitingKey ?? "loginWaiting") })
								]
							}),
							jsx("p", { className: "wbm-hint", children: t(LOGIN_VARIANTS.find((v) => v.key === login.variantKey)?.hintKey ?? "loginScanHint") })
						]
					}) : null,

					phase === "done" ? jsxs(Fragment, {
						children: [
							jsx("p", { className: "wbm-ok-text", children: t("loginSucceeded") }),
							jsx("div", {
								className: "wbm-actions",
								children: jsx("button", { type: "button", className: "wbm-btn", onClick: () => reset(), children: t("loginRetry") })
							})
						]
					}) : null
				]
			}, "login-panel");
		}

		/**
		 * The whole settings body. Shared by the settings-tab card and the Plugins-page
		 * config surface, which render the same document and the same actions.
		 */
		function CardBody({ state, t }) {
			const { status, readFailure, busy, refresh, run } = state;
			const [loginOpen, setLoginOpen] = react.useState(false);
			const [highlightUid, setHighlightUid] = react.useState(void 0);
			ensureUiCss();

			/**
			 * A sign-in landed. Re-read so the new account appears, and mark it so the user
			 * can find it in a list they did not watch being built. The marker is cleared
			 * when the panel is reopened, so this owns no timer of its own.
			 */
			const onLanded = (meta) => {
				const uid = meta !== null && typeof meta === "object" ? meta.uid : void 0;
				if (typeof uid === "string" && uid !== "") setHighlightUid(uid);
				refresh();
			};

			return jsxs("div", {
				className: "wbm",
				children: [
					jsx(StatusBar, {
						status,
						busy,
						refresh,
						loginOpen,
						onToggleLogin: () => {
							const next = !loginOpen;
							setLoginOpen(next);
							if (next) setHighlightUid(void 0);
						},
						t
					}),
					jsx(UpstreamBanner, { t }),
					readFailure === void 0 ? null : jsxs("div", {
						className: "wbm-banner wbm-banner--err",
						role: "alert",
						children: [
							jsx("div", { className: "wbm-banner-title", children: t("readFailed") }),
							jsx("p", { className: "wbm-banner-text", children: readFailure })
						]
					}),
					loginOpen ? jsx(LoginPanel, { t, onLanded, onClose: () => setLoginOpen(false) }) : null,
					status === void 0 ? jsx("p", { className: "wbm-muted", children: t("loading") }) : jsxs(Fragment, {
						children: [
							jsx(AttentionBanner, { warnings: status.warnings, t }),
							...arrayOf(status.variants).map((variant) => jsx(VariantSection, {
								variant,
								credits: status.credits,
								highlightUid,
								busy,
								run,
								t
							}, variant.key)),
							jsx(UpstreamConnect, { status, t }),
							jsx(SettingsSection, { status, busy, run, t })
						]
					})
				]
			});
		}

		/**
		 * The `settings.plugin.item` card (older hosts): a collapsible row in the
		 * settings Plugins tab.
		 */
		function WorkBuddyMultiCard({ t = defaultTranslate }) {
			const [open, setOpen] = react.useState(false);
			const state = useHostStatus(open);
			const title = t("cardTitle");
			ensureUiCss();
			return jsxs("li", {
				className: "wbm-card",
				children: [
					jsxs("button", {
						type: "button",
						className: "wbm-card-head",
						"aria-expanded": open,
						"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
						onClick: () => setOpen(!open),
						children: [
							jsxs("span", {
								children: [
									jsx("b", { children: title }),
									jsx("small", { children: open ? t("cardIntro") : summarize(state.status, t) })
								]
							}),
							jsx("svg", {
								viewBox: "0 0 16 16",
								fill: "none",
								stroke: "currentColor",
								strokeWidth: 1.5,
								strokeLinecap: "round",
								strokeLinejoin: "round",
								"aria-hidden": "true",
								style: { transform: open ? "rotate(180deg)" : "none" },
								children: jsx("path", { d: ICON_PATHS.chevron })
							})
						]
					}),
					open ? jsx("div", { className: "wbm-card-body", children: jsx(CardBody, { state, t }) }) : null
				]
			});
		}

		/**
		 * The `plugins.bundle.config` page: the same body, always expanded, since the
		 * Plugins page has already chosen this bundle and shows its name above us.
		 */
		function WorkBuddyMultiConfigPage({ t = defaultTranslate }) {
			const state = useHostStatus(true);
			return jsx(CardBody, { state, t });
		}

		/**
		 * The composer chip: this group's total credits, beside upstream's per-account chip.
		 *
		 * Three gates, each a plain fact: merged mode (a total only means something once
		 * the accounts share one route), a base route (a per-account group has nothing
		 * to sum), and a resolved selection. When any fails this returns `null` and,
		 * because the poll is gated on the same provider check, costs nothing.
		 */
		function CreditsChip({ directory, t = defaultTranslate }) {
			const subscribe = react.useCallback((listener) => directory.subscribe(listener), [directory]);
			const snapshot = react.useCallback(() => directory.getSnapshot(), [directory]);
			const selection = react.useSyncExternalStore(subscribe, snapshot, snapshot).current;
			const provider = providerOf(selection);
			const providerVariant = variantKeyForProvider(provider);
			const [chipOff, setChipOff] = react.useState(false);
			const state = useHostStatus(providerVariant !== void 0 && !chipOff, CREDITS_POLL_MS);
			/*
			 * 「隐藏 chip」是宿主状态里的一个布尔（composerChip）。没到读过它之前先按显示处理
			 * （读一次才能知道），读到 false 就停轮询、不再渲染。
			 */
			const composerChip = state.status?.composerChip;
			react.useEffect(() => {
				if (composerChip === false) setChipOff(true);
				else if (composerChip === true) setChipOff(false);
			}, [composerChip]);
			const variantKey = chipVariantKey(state.status, provider);
			const aggregate = creditsFor(state.status?.credits, variantKey);
			/**
			 * One TTL-respecting ask per mount, so the chip does not sit at 未知 until the
			 * user finds the ↻. No `force`: the host applies its TTL and dedupes concurrent
			 * asks, so several sessions rendering this slot still cost one round.
			 */
			const askedRef = react.useRef(false);
			const busy = state.busy;
			const run = state.run;
			const credits = state.status?.credits;
			react.useEffect(() => {
				if (variantKey === void 0 || chipOff) return;
				if (askedRef.current) return;
				if (busy) return;
				if (!creditsStale(creditsFor(credits, variantKey), credits?.ttlMs, Date.now())) return;
				askedRef.current = true;
				run(ACTIONS.refreshCredits, { variantKey });
			}, [variantKey, aggregate, busy, run, credits, chipOff]);
			/*
			 * 合并模式的标记只跟「当前选中的是不是合并组」走，**不跟 chip 的显示开关走**：
			 * 上游那条单账号积分是靠这个标记收掉的，chip 隐藏时标记也必须还在，
			 * 否则输入框会冒出上游的数字（用户看到的就是「上游的全显示了」）。
			 */
			useMergedMarker(variantKey !== void 0);
			react.useEffect(() => {
				ensureCreditsCss();
			}, []);
			if (variantKey === void 0 || chipOff) return null;
			return /* @__PURE__ */ jsxs("div", {
				style: chipStyle,
				children: [
					/* @__PURE__ */ jsx("span", {
						style: chipTextStyle,
						title: creditTooltip(aggregate, groupNameFor(state.status, variantKey), t),
						children: creditChipLabel(state.status, variantKey, t)
					}),
					/* @__PURE__ */ jsx("button", {
						type: "button",
						style: chipButtonStyle,
						disabled: state.busy,
						title: t("creditsRefreshPooled"),
						"aria-label": t("creditsRefreshPooled"),
						onClick: () => {
							state.run(ACTIONS.refreshCredits, { variantKey, force: true });
						},
						children: state.busy ? "…" : "↻"
					})
				]
			});
		}
		//#endregion

		//#region src/upstream-connect.js
		/**
		 * 上游 dsh-workbuddy-connect 的设置面板，整体搬进本插件的卡片。
		 *
		 * 上游卡片做的每件事都由它自己的两个同源路由驱动（GET status 读全部状态，
		 * POST probe 路由做全部写操作，写操作带 `X-WorkBuddy-Probe-Key` 头），所以这里
		 * 不复制任何服务端逻辑：面板就是上游状态文档的另一种渲染。上游没装/没启用时
		 * 两个变体面板的 GET 都是 404 —— 那种情形由 UpstreamBanner（去插件市场安装）
		 * 兜底，这里整体不渲染，免得同一句话在卡片里说两遍。
		 *
		 * 与上游卡片的两处刻意差异：
		 *   - 推理档位的检测结果标注了「共享自账号 x」——那是本插件按「版本+模型」
		 *     汇总出来的（status.reasoning），上游自己的结果只按当前账号显示；
		 *   - 多了「全部检测」：对还没有结果的候选模型依次各测一次（上游 probe
		 *     服务内部本来就是串行的，这里只是替用户挨个点）。
		 */
		const UPSTREAM_CONNECT_VARIANTS = [
			{
				key: "cn",
				routeId: "workbuddy",
				statusPath: "/plugins/dsh-workbuddy-connect/status",
				probePath: "/plugins/dsh-workbuddy-connect/probe",
				titleKey: "connectCnTitle",
				signedOutHintKey: "connectSignedOutHintCn",
				appName: "WorkBuddy"
			},
			{
				key: "ai",
				routeId: "workbuddy-ai",
				statusPath: "/plugins/dsh-workbuddy-connect/ai/status",
				probePath: "/plugins/dsh-workbuddy-connect/ai/probe",
				titleKey: "connectAiTitle",
				signedOutHintKey: "connectSignedOutHintAi",
				appName: "WorkBuddy AI"
			}
		];
		const UPSTREAM_UPDATE_PATH = "/plugins/dsh-workbuddy-connect/update";
		const PROBE_KEY_HEADER = "X-WorkBuddy-Probe-Key";

		/** 上游 status 文档的最小校验（与上游 isWorkBuddyWebStatus 同判据）。 */
		function isUpstreamStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const status = value["status"];
			if (status === "signed-out" || status === "signed-in") return true;
			return status === "error" && typeof value["message"] === "string";
		}

		/**
		 * 面板自己的 fetch 通道：拿过滤器包之前的原始 fetch。
		 *
		 * 过滤器是给输入框的「推理等级」按钮用的；本面板的 status 读取若走被包装的
		 * window.fetch，probe.candidates 会被清空，面板就瞎了（「当前没有可检测的模型」
		 * 其实有一堆）。装过滤器之前（或没装上）时退化成普通 fetch。
		 */
		function upstreamFetch(input, init) {
			const original = globalThis[Symbol.for("dsh-workbuddy-multi:reasoning-filter")]?.original;
			return (typeof original === "function" ? original : fetch)(input, init);
		}

		/** 上游 status 的读取 hook：纪律与 useHostStatus 相同（read-seq 最新者胜、失败不丢旧文档）。 */
		function useUpstreamStatus(variant, active) {
			const [status, setStatus] = react.useState(void 0);
			const [notFound, setNotFound] = react.useState(false);
			const [readFailure, setReadFailure] = react.useState(void 0);
			const mounted = react.useRef(true);
			const readSeq = react.useRef(0);
			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const refresh = react.useCallback(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await upstreamFetch(variant.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...(signal === void 0 ? {} : { signal })
					});
					if (response.status === 404) {
						if (current()) {
							setNotFound(true);
							setReadFailure(void 0);
						}
						return false;
					}
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isUpstreamStatus(value)) throw new Error("bad-status-document");
					if (!current()) return false;
					setNotFound(false);
					setStatus(value);
					setReadFailure(void 0);
					return true;
				} catch (error) {
					if (current()) setReadFailure(error instanceof Error ? error.message : String(error));
					return false;
				}
			}, [variant.statusPath]);
			react.useEffect(() => {
				if (!active) return;
				const controller = new AbortController();
				refresh(controller.signal);
				return () => controller.abort();
			}, [active, refresh]);
			react.useEffect(() => {
				if (!active) return;
				const timer = window.setInterval(() => {
					refresh();
				}, POLL_INTERVAL_MS);
				return () => window.clearInterval(timer);
			}, [active, refresh]);
			const control = react.useCallback(async (payload) => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (typeof key !== "string" || key === "") throw new Error("missing-probe-key");
				const response = await upstreamFetch(variant.probePath, {
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json", [PROBE_KEY_HEADER]: key },
					body: JSON.stringify(payload)
				});
				const body = await response.json().catch(() => void 0);
				if (!response.ok) {
					const reason = body !== null && typeof body === "object" && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
					throw new Error(reason);
				}
				return body;
			}, [variant.probePath, status]);
			return { status, notFound, readFailure, refresh, control };
		}

		/** 积分合计的紧凑文本；unlimited 优先于数字（上游判据）。 */
		function connectCreditsText(credits) {
			if (credits === null || typeof credits !== "object") return void 0;
			if (credits.unlimited === true) return "∞";
			if (typeof credits.total === "number" && Number.isFinite(credits.total)) {
				return new Intl.NumberFormat(void 0, { maximumFractionDigits: 2 }).format(credits.total);
			}
			return void 0;
		}

		/** 上下文窗口的紧凑标记（200K / 1M）。 */
		function formatWindow(tokens) {
			if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return void 0;
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`;
			return String(tokens);
		}

		/**
		 * 推理档位检测区：候选模型逐个检测 / 全部检测 / 清除结果。
		 *
		 * 每个候选模型的「已知结果」有两个来源：上游的 probe.results（当前账号自己的
		 * 记录）和本插件的汇总缓存（任何账号的记录，标「共享自」）。两个都有时上游的
		 * 优先展示 —— 它是本账号当下真正生效的那份。
		 */
		/**
		 * 推理档位检测区：候选模型逐个检测 / 全部检测。
		 *
		 * 每个候选模型的「已知结果」有两个来源：上游的 probe.results（当前账号自己的
		 * 记录）和本插件的汇总缓存（任何账号的记录，标「共享自」）。两个都有时上游的
		 * 优先展示 —— 它是本账号当下真正生效的那份。
		 *
		 * 拿到决定性结果的模型进「已检测」组（默认收起），不再占主列表 —— 主列表只留
		 * 「没测过 / 没测成」的，那才是需要动手的。
		 *
		 * 注意这里没有「清除全部结果」入口：上游的 clear 会清掉**所有账号**的全部记录，
		 * 一次误点就把别人花积分测出来的结果全毁了。要重来就逐个「重新检测」。
		 */
		function ConnectProbePanel({ variant, probe, models, shared, control, refresh, t }) {
			const [pending, setPending] = react.useState(void 0);
			const [confirmAll, setConfirmAll] = react.useState(false);
			const [progress, setProgress] = react.useState(void 0);
			const [summary, setSummary] = react.useState(void 0);
			const [failed, setFailed] = react.useState(void 0);
			/** 单个模型检测中的 id（按行的小动画）。 */
			const [detecting, setDetecting] = react.useState(void 0);
			/** 检测区默认收起（候选可能一长串）；检测进行中、要点确认、或有结果/失败要看时自动展开。 */
			const [probeOpen, setProbeOpen] = react.useState(false);
			/** 「已检测」组（默认收起）。 */
			const [resolvedOpen, setResolvedOpen] = react.useState(false);
			/**
			 * 每个模型最近一次失败的原因（本会话内保留）。「检测未完成」本身什么都没说，
			 * 而真实原因差别很大：账号类型无权调用（11158）是**永久**的，重测一百次也一样；
			 * 模型繁忙/限流是暂时的。逐行留下原因，用户才分得清。
			 */
			const [rowErrors, setRowErrors] = react.useState({});
			const mounted = react.useRef(true);
			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const sharedById = new Map(shared.map((entry) => [entry.id, entry]));
			const results = Array.isArray(probe?.results) ? probe.results : [];
			const candidates = Array.isArray(probe?.candidates) ? probe.candidates : [];
			const running = probe?.running === true || progress !== void 0;
			/** 「账号无权使用」类失败：重测不会改变答案，「全部检测」跳过它们。 */
			const ENTITLEMENT = /not allowed for user type|account type does not support/iu;
			/** 「模型繁忙/请求太频繁」（429/14003）：暂时的，隔一会重试有意义。 */
			const BUSY = /14003|too many requests|model busy|模型繁忙/iu;
			/** 上游的 reason 是一整段 JSON：收成一句人话再显示。 */
			const probeErrorText = (message) => {
				if (BUSY.test(message)) return t("connectProbeBusy");
				if (ENTITLEMENT.test(message)) return t("connectProbeNoEntitlement");
				return message.length > 220 ? `${message.slice(0, 220)}…` : message;
			};
			const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
			/** 「全部检测」的节奏：每个模型之间停 2s，撞上繁忙停 15s 自动重试一次。 */
			const PROBE_BETWEEN_MODELS_MS = 2000;
			const PROBE_BUSY_RETRY_MS = 15000;
			const noteError = (id, message) => {
				setRowErrors((previous) => {
					const next = { ...previous };
					if (message === void 0) delete next[id];
					else next[id] = message;
					return next;
				});
			};
			/** 有决定性结果（本账号 validating/non-validating，或共享缓存里有）的模型算「已检测」。 */
			const isResolved = (id) => {
				const own = results.find((entry) => entry.id === id);
				if (own !== void 0 && (own.validation === "validating" || own.validation === "non-validating")) return true;
				return sharedById.has(id);
			};
			const resolved = candidates.filter(isResolved);
			const unresolved = candidates.filter((id) => !isResolved(id));
			/** 还没有任何决定性结果、且不是已知无权调用的候选 —— 「全部检测」只测这些。 */
			const untested = unresolved.filter((id) => {
				const error = rowErrors[id];
				return !(typeof error === "string" && ENTITLEMENT.test(error));
			});
			/**
			 * 展开语义：检测进行中/确认框打开时强制展开；检测出结果（成功或失败）的那一刻
			 * 自动展开一次（setProbeOpen(true)），之后用户随时可以收回来 —— 结果本身不再
			 * 参与展开判定，否则「收不回来」。
			 */
			const open = probeOpen || progress !== void 0 || detecting !== void 0 || confirmAll;

			const detectOne = async (model) => {
				setPending(void 0);
				setSummary(void 0);
				setFailed(void 0);
				setDetecting(model);
				setProbeOpen(true);
				try {
					const body = await control({ action: "probe", model });
					if (body === null || typeof body !== "object" || body.state !== "ok") {
						throw new Error(typeof body?.reason === "string" ? body.reason : "probe failed");
					}
					noteError(model, void 0);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (mounted.current) {
						setFailed(message);
						noteError(model, message);
					}
				} finally {
					if (mounted.current) setDetecting(void 0);
				}
				await refresh();
			};

			const detectAll = async () => {
				setConfirmAll(false);
				setSummary(void 0);
				setFailed(void 0);
				setProbeOpen(true);
				let ok = 0;
				let failedCount = 0;
				const total = untested.length;
				/** 单个模型测一次；成功返回 true，失败抛出带 reason 的错。 */
				const probeOnce = async (id) => {
					const body = await control({ action: "probe", model: id });
					if (body !== null && typeof body === "object" && body.state === "ok") return true;
					throw new Error(typeof body?.reason === "string" ? body.reason : "probe failed");
				};
				for (const [index, id] of untested.entries()) {
					if (!mounted.current) return;
					setProgress({ done: index, total, model: id, retrying: false });
					try {
						await probeOnce(id);
						ok += 1;
						noteError(id, void 0);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (BUSY.test(message)) {
							// 频控是暂时的：停 15s 自动重试一次；再失败就如实记录，轮到下一个模型。
							if (!mounted.current) return;
							setProgress({ done: index, total, model: id, retrying: true });
							await sleepMs(PROBE_BUSY_RETRY_MS);
							if (!mounted.current) return;
							try {
								await probeOnce(id);
								ok += 1;
								noteError(id, void 0);
							} catch (retryError) {
								failedCount += 1;
								noteError(id, retryError instanceof Error ? retryError.message : String(retryError));
							}
						} else {
							failedCount += 1;
							noteError(id, message);
						}
					}
					if (index < total - 1) await sleepMs(PROBE_BETWEEN_MODELS_MS);
				}
				if (!mounted.current) return;
				setProgress(void 0);
				setSummary({ ok, failed: failedCount });
				await refresh();
			};

			const rowFor = (id) => {
				const model = (Array.isArray(models) ? models : []).find((entry) => entry.id === id);
				const own = results.find((entry) => entry.id === id);
				const sharedRecord = sharedById.get(id);
				const name = model?.name ?? own?.name ?? id;
				let chip;
				if (own !== void 0) {
					chip = own.validation === "validating" && Array.isArray(own.efforts) && own.efforts.length > 0
						? t("connectProbeKnown", { levels: own.efforts.join(" / ") })
						: own.validation === "non-validating"
							? t("connectProbeNotValidating")
							: t("connectProbeUnknown");
				} else if (sharedRecord !== void 0) {
					chip = sharedRecord.validation === "validating" && Array.isArray(sharedRecord.efforts) && sharedRecord.efforts.length > 0
						? `${t("connectProbeKnown", { levels: sharedRecord.efforts.join(" / ") })} · ${t("connectProbeShared", { account: shortUid(sharedRecord.account) })}`
						: t("connectProbeNotValidating");
				} else {
					chip = t("connectProbeUntested");
				}
				return jsxs("li", {
					className: "wbm-row",
					children: [
						jsx("span", { className: "wbm-dot", "aria-hidden": "true" }),
						jsxs("div", {
							className: "wbm-row-main",
							children: [
								jsxs("div", {
									className: "wbm-row-title",
									children: [
										jsx("span", { className: "wbm-name", children: name }),
										jsx("span", { className: "wbm-tag", children: chip })
									]
								}),
								own !== void 0 && typeof own.probedAt === "number" ? jsx("span", {
									className: "wbm-meta",
									children: t("connectProbeResultAt", { time: formatInstant(own.probedAt) })
								}) : null,
								typeof rowErrors[id] === "string" ? jsx("span", {
									className: "wbm-meta wbm-note--err",
									role: "alert",
									children: t("connectProbeFailed", { message: probeErrorText(rowErrors[id]) })
								}) : null
							]
						}),
						jsx("div", {
							className: "wbm-row-side",
							children: jsxs("button", {
								type: "button",
								className: "wbm-btn wbm-btn--sm",
								disabled: running || detecting === id,
								onClick: () => setPending(id),
								children: [
									detecting === id || progress?.model === id ? jsx(Icon, { name: "refresh", spin: true }) : null,
									t(own === void 0 && sharedRecord === void 0 ? "connectProbeStart" : "connectProbeRedetect")
								]
							})
						}),
						pending === id ? jsxs("div", {
							className: "wbm-row-panel",
							children: [
								jsx("p", { className: "wbm-hint", children: t("connectProbeConfirmBody", { model: name }) }),
								jsxs("div", {
									className: "wbm-actions",
									children: [
										jsx("button", { type: "button", className: "wbm-btn wbm-btn--sm", onClick: () => setPending(void 0), children: t("connectProbeCancel") }),
										jsx("button", { type: "button", className: "wbm-btn wbm-btn--primary wbm-btn--sm", disabled: running, onClick: () => detectOne(id), children: t("connectProbeConfirmAction") })
									]
								})
							]
						}) : null
					]
				}, id);
			};

			return jsxs("div", {
				className: "wbm-sub",
				children: [
					jsxs("div", {
						className: "wbm-sub-head",
						children: [
							jsxs("button", {
								type: "button",
								className: "wbm-sub-toggle",
								"aria-expanded": open,
								onClick: () => setProbeOpen(!probeOpen),
								children: [
									jsx("span", { children: t("connectProbeHeadingCount", { count: candidates.length }) }),
									jsx("svg", {
										viewBox: "0 0 16 16",
										fill: "none",
										stroke: "currentColor",
										strokeWidth: 1.5,
										strokeLinecap: "round",
										strokeLinejoin: "round",
										"aria-hidden": "true",
										className: "wbm-chevron",
										style: { transform: open ? "rotate(180deg)" : "none", width: 14, height: 14 },
										children: jsx("path", { d: ICON_PATHS.chevron })
									})
								]
							}),
							untested.length === 0 ? null : jsx("button", {
								type: "button",
								className: "wbm-btn wbm-btn--sm",
								disabled: running,
								onClick: () => setConfirmAll(true),
								children: t("connectProbeAll")
							})
						]
					}),
					open ? jsxs(Fragment, {
						children: [
							jsx("p", { className: "wbm-hint", children: t("connectProbeIntro") }),
							progress !== void 0 ? jsxs("p", {
								className: "wbm-hint",
								role: "status",
								children: [
									jsx(Icon, { name: "refresh", spin: true }),
									" ",
									progress.retrying === true
										? t("connectProbeRetrying", { model: progress.model, seconds: PROBE_BUSY_RETRY_MS / 1000 })
										: t("connectProbeAllProgress", { done: progress.done + 1, total: progress.total, model: progress.model })
								]
							}) : null,
							summary === void 0 ? null : jsx("p", {
								className: "wbm-hint",
								role: "status",
								children: t("connectProbeAllDone", { ok: summary.ok, failed: summary.failed })
							}),
							failed === void 0 ? null : jsx("p", {
								className: "wbm-note wbm-note--err",
								role: "alert",
								children: t("connectProbeFailed", { message: probeErrorText(failed) })
							}),
							confirmAll ? jsxs("div", {
								className: "wbm-banner",
								children: [
									jsx("p", { className: "wbm-banner-text", children: t("connectProbeAllConfirm", { count: untested.length }) }),
									jsxs("div", {
										className: "wbm-banner-actions",
										children: [
											jsx("button", { type: "button", className: "wbm-btn wbm-btn--sm", onClick: () => setConfirmAll(false), children: t("connectProbeCancel") }),
											jsx("button", { type: "button", className: "wbm-btn wbm-btn--primary wbm-btn--sm", onClick: detectAll, children: t("connectProbeConfirmAction") })
										]
									})
								]
							}) : null,
							unresolved.length === 0 && resolved.length === 0 ? jsx("p", { className: "wbm-hint", children: t("connectProbeEmpty") }) : null,
							unresolved.length === 0 && resolved.length > 0 ? jsx("p", { className: "wbm-hint", children: t("connectProbeAllResolved") }) : null,
							unresolved.length === 0 ? null : jsx("ul", {
								className: "wbm-list",
								children: unresolved.map(rowFor)
							}),
							resolved.length === 0 ? null : jsxs(Fragment, {
								children: [
									jsxs("button", {
										type: "button",
										className: "wbm-sub-head wbm-sub-toggle",
										"aria-expanded": resolvedOpen,
										onClick: () => setResolvedOpen(!resolvedOpen),
										children: [
											jsx("span", { children: t("connectProbeResolvedGroup", { count: resolved.length }) }),
											jsx("svg", {
												viewBox: "0 0 16 16",
												fill: "none",
												stroke: "currentColor",
												strokeWidth: 1.5,
												strokeLinecap: "round",
												strokeLinejoin: "round",
												"aria-hidden": "true",
												className: "wbm-chevron",
												style: { transform: resolvedOpen ? "rotate(180deg)" : "none", width: 14, height: 14 },
												children: jsx("path", { d: ICON_PATHS.chevron })
											})
										]
									}),
									resolvedOpen ? jsx("ul", {
										className: "wbm-list",
										children: resolved.map(rowFor)
									}) : null
								]
							})
						]
					}) : null
				]
			});
		}		/** 一个变体（国内版 / 国际版）的上游设置面板。 */
		function ConnectVariantPanel({ variant, reasoning, t }) {
			const { status, notFound, readFailure, refresh, control } = useUpstreamStatus(variant, true);
			const [busyRow, setBusyRow] = react.useState(void 0);
			const [writeFailure, setWriteFailure] = react.useState(void 0);
			const [assistantOpen, setAssistantOpen] = react.useState(false);
			const [copied, setCopied] = react.useState(false);
			/** 模型列表默认收起：目录一长串，平时要看的只是「有几个模型」。 */
			const [modelsOpen, setModelsOpen] = react.useState(false);
			/** 面板右上角刷新按钮的在飞状态（小动画）。 */
			const [refreshing, setRefreshing] = react.useState(false);
			if (notFound) return null;

			const signedIn = status?.status === "signed-in";
			const models = signedIn && Array.isArray(status.models) ? status.models : [];
			const visibility = signedIn ? status.visibility : void 0;
			const hiddenIds = new Set(Array.isArray(visibility?.disabled) ? visibility.disabled : []);
			const shared = reasoning?.variants?.[variant.key]?.models ?? [];
			/** 检测所得的档位（本账号记录优先于共享缓存）：目录没声明的模型靠它贴上标签。 */
			const ownProbeById = new Map((signedIn && Array.isArray(status.probe?.results) ? status.probe.results : []).map((entry) => [entry.id, entry]));
			const sharedProbeById = new Map(shared.map((entry) => [entry.id, entry]));

			const runWrite = async (payload, rowKey) => {
				setWriteFailure(void 0);
				if (rowKey !== void 0) setBusyRow(rowKey);
				try {
					const body = await control(payload);
					if (body !== null && typeof body === "object" && body.state === "stale-account") {
						setWriteFailure(t("connectVisibilityStale"));
					} else if (body !== null && typeof body === "object" && body.state === "failed") {
						setWriteFailure(typeof body.reason === "string" ? body.reason : "failed");
					}
				} catch (error) {
					setWriteFailure(error instanceof Error ? error.message : String(error));
				} finally {
					if (rowKey !== void 0) setBusyRow(void 0);
				}
				await refresh();
			};

			const assistantPrompt = t("connectAssistantPrompt", {
				appName: variant.appName,
				failureSummary: status?.status === "error" ? status.message : (readFailure ?? "unknown")
			});

			return jsxs("div", {
				className: "wbm-panel",
				children: [
					jsxs("div", {
						className: "wbm-panel-head",
						children: [
							jsx("b", { children: t(variant.titleKey) }),
							jsxs("button", {
								type: "button",
								className: "wbm-btn wbm-btn--quiet wbm-btn--sm",
								disabled: refreshing,
								onClick: async () => {
									setRefreshing(true);
									try {
										await refresh();
									} finally {
										setRefreshing(false);
									}
								},
								children: [refreshing ? jsx(Icon, { name: "refresh", spin: true }) : null, t("refresh")]
							})
						]
					}),
					status === void 0 ? jsx("p", { className: "wbm-muted", children: t("loading") }) : null,
					status?.status === "error" ? jsxs(Fragment, {
						children: [
							jsx("p", { className: "wbm-note wbm-note--err", children: t("connectUnavailable", { message: status.message }) }),
							jsx("button", {
								type: "button",
								className: "wbm-btn wbm-btn--sm",
								onClick: () => setAssistantOpen(!assistantOpen),
								children: t("connectAssistantHeading")
							})
						]
					}) : null,
					assistantOpen ? jsxs("div", {
						className: "wbm-banner",
						children: [
							jsx("p", { className: "wbm-banner-text", children: t("connectAssistantIntro") }),
							jsx("code", { className: "wbm-code", children: assistantPrompt }),
							jsx("div", {
								className: "wbm-banner-actions",
								children: jsx("button", {
									type: "button",
									className: "wbm-btn wbm-btn--sm",
									onClick: () => {
										const done = () => setCopied(true);
										const fail = () => setCopied(false);
										try {
											if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== void 0) {
												navigator.clipboard.writeText(assistantPrompt).then(done, fail);
											} else {
												fail();
											}
										} catch {
											fail();
										}
									},
									children: copied ? t("connectAssistantCopied") : t("connectAssistantCopy")
								})
							})
						]
					}) : null,
					status?.status === "signed-out" ? jsxs(Fragment, {
						children: [
							jsx("p", { className: "wbm-note", children: t("connectSignedOut") }),
							jsx("p", { className: "wbm-hint", children: t(variant.signedOutHintKey) })
						]
					}) : null,
					signedIn ? jsxs(Fragment, {
						children: [
							jsxs("div", {
								className: "wbm-statusline",
								children: [
									jsx("span", { className: "wbm-dot wbm-dot--ok", "aria-hidden": "true" }),
									jsx("span", { className: "wbm-ok-text", children: t("connectSignedInAs", { nickname: status.nickname ?? status.domain ?? "?" }) }),
									typeof status.expiresAt === "number" ? jsx("span", { children: t("connectTokenExpires", { time: formatInstant(status.expiresAt) }) }) : null,
									status.creditsError !== void 0
										? jsx("span", { className: "wbm-note--err", children: t("connectCreditsError", { message: status.creditsError }) })
										: jsx("span", {
											children: `${t("connectCredits")} ${connectCreditsText(status.credits) ?? t("connectCreditsUnknown")}`
										})
								]
							}),
							jsxs("div", {
								className: "wbm-statusline",
								children: [
									jsx("span", {
										children: status.catalog?.source === "live"
											? t("connectCatalogLive", { time: formatInstant(status.catalog.fetchedAt) })
											: status.catalog?.source === "saved"
												? t("connectCatalogSaved", { time: formatInstant(status.catalog.fetchedAt) })
												: t("connectCatalogFallback")
									}),
									typeof status.catalog?.appVersion === "string" ? jsx("span", { children: t("connectAppVersion", { version: status.catalog.appVersion }) }) : null,
									typeof status.catalog?.error === "string" ? jsx("span", { className: "wbm-note--err", children: t("connectCatalogError", { message: status.catalog.error }) }) : null,
									jsxs("button", {
										type: "button",
										className: "wbm-btn wbm-btn--quiet wbm-btn--sm",
										disabled: busyRow === "refresh-models",
										onClick: () => runWrite({ action: "refresh" }, "refresh-models"),
										children: [
											busyRow === "refresh-models" ? jsx(Icon, { name: "refresh", spin: true }) : null,
											t(busyRow === "refresh-models" ? "connectRefreshingModels" : "connectRefreshModels")
										]
									})
								]
							}),
							writeFailure === void 0 ? null : jsx("p", { className: "wbm-note wbm-note--err", role: "alert", children: writeFailure }),
							models.length === 0 ? null : jsxs("div", {
								className: "wbm-sub",
								children: [
									jsxs("button", {
										type: "button",
										className: "wbm-sub-head wbm-sub-toggle",
										"aria-expanded": modelsOpen,
										onClick: () => setModelsOpen(!modelsOpen),
										children: [
											jsx("span", { children: t("connectModelsHeadingCount", { count: models.length }) }),
											jsx("svg", {
												viewBox: "0 0 16 16",
												fill: "none",
												stroke: "currentColor",
												strokeWidth: 1.5,
												strokeLinecap: "round",
												strokeLinejoin: "round",
												"aria-hidden": "true",
												className: "wbm-chevron",
												style: { transform: modelsOpen ? "rotate(180deg)" : "none", width: 14, height: 14 },
												children: jsx("path", { d: ICON_PATHS.chevron })
											})
										]
									}),
									modelsOpen ? jsxs(Fragment, {
										children: [
											visibility !== void 0 ? jsx("p", { className: "wbm-hint", children: t("connectVisibilityHint") }) : null,
											jsx("ul", {
										className: "wbm-list",
										children: models.map((model) => {
											const capacity = formatWindow(model.contextWindow);
											const maximum = formatWindow(model.maxContextWindow);
											const rowKey = `vis:${model.id}`;
											const metaParts = [];
											if (typeof model.credits === "string") metaParts.push(t("connectRate", { rate: model.credits }));
											else if (model.rateUnknown === true) metaParts.push(t("connectRateUnknown"));
											if (capacity !== void 0) metaParts.push(capacity);
											if (maximum !== void 0) metaParts.push(t("connectContextUpTo", { size: maximum }));
											if (maximum !== void 0 && typeof model.defaultContextWindow === "number") {
												metaParts.push(`（${t("connectContextDefault", { size: formatWindow(model.defaultContextWindow) ?? String(model.defaultContextWindow) })}）`);
											}
											return jsxs("li", {
												className: "wbm-row",
												children: [
													jsx("span", { className: "wbm-dot", "aria-hidden": "true" }),
													jsxs("div", {
														className: "wbm-row-main",
														children: [
															jsxs("div", {
																className: "wbm-row-title",
																children: [
																	visibility === void 0 ? null : jsx("input", {
																		type: "checkbox",
																		className: "wbm-check-input",
																		checked: !hiddenIds.has(model.id),
																		disabled: busyRow === rowKey,
																		"aria-label": model.name ?? model.id,
																		onChange: (event) => runWrite({
																			action: "set-model-visibility",
																			model: model.id,
																			visible: event.target.checked,
																			account: visibility.account
																		}, rowKey)
																	}),
																	jsx("span", { className: "wbm-name", children: model.name ?? model.id }),
																	model.free === true ? jsx("span", { className: "wbm-tag", children: t("connectFree") }) : null,
																	(Array.isArray(model.badges) ? model.badges : []).map((badge) => jsx("span", { className: "wbm-tag", children: String(badge) }, `${model.id}:${String(badge)}`)),
																	(() => {
																		if (Array.isArray(model.declaredEfforts) && model.declaredEfforts.length > 0) {
																			return jsx("span", { className: "wbm-tag wbm-tag--strong", children: model.declaredEfforts.join(" / ") });
																		}
																		const ownRec = ownProbeById.get(model.id);
																		const sharedRec = sharedProbeById.get(model.id);
																		const detected = ownRec?.validation === "validating" && Array.isArray(ownRec.efforts) && ownRec.efforts.length > 0
																			? ownRec.efforts
																			: sharedRec?.validation === "validating" && Array.isArray(sharedRec.efforts) && sharedRec.efforts.length > 0
																				? sharedRec.efforts
																				: void 0;
																		return detected === void 0 ? null : jsx("span", {
																			className: "wbm-tag wbm-tag--strong",
																			title: t("connectModelDetectedLevels"),
																			children: detected.join(" / ")
																		});
																	})()
																]
															}),
															metaParts.length === 0 ? null : jsx("span", { className: "wbm-meta", children: metaParts.join(" · ") })
														]
													})
												]
											}, model.id);
										})
									})
									]
									}) : null,
									typeof status.useMaximumContextWindow === "boolean" ? jsxs("label", {
										className: "wbm-check",
										children: [
											jsx("input", {
												type: "checkbox",
												className: "wbm-check-input",
												checked: status.useMaximumContextWindow,
												disabled: busyRow === "max-window",
												onChange: (event) => runWrite({ action: "set-maximum-context-window", enabled: event.target.checked }, "max-window")
											}),
											jsxs("span", {
												children: [
													t("connectMaxWindow"),
													" ",
													jsx("span", { className: "wbm-hint", children: t("connectMaxWindowHint") })
												]
											})
										]
									}) : null
								]
							}),
							jsx(ConnectProbePanel, {
								variant,
								probe: status.probe,
								models,
								shared,
								control,
								refresh,
								t
							})
						]
					}) : null,
					readFailure === void 0 || status !== void 0 ? null : jsx("p", { className: "wbm-note wbm-note--err", children: t("connectUnavailable", { message: readFailure }) })
				]
			});
		}


		/**
		 * 「上游 Connect」整区：两个变体的面板 + 一行版本检查。
		 * 某个变体 404（上游没装/没启用）时那个面板自己不渲染 —— 那种情形由 UpstreamBanner 兜底。
		 *
		 * 整区的总闸门是宿主报告的 `upstream.installed`：本插件进程没加载到上游模块时，
		 * 上游路由不可能存在，两个面板连 GET 都不发（未就绪的 503 空壳也是这个状态）。
		 */
		function UpstreamConnect({ status, t }) {
			const reasoning = status?.reasoning;
			if (status?.upstream?.installed !== true) return null;
			return jsxs("section", {
				className: "wbm-section",
				children: [
					jsx("div", {
						className: "wbm-section-head",
						children: jsx("div", {
							className: "wbm-section-title",
							children: jsx("h3", { children: t("connectHeading") })
						})
					}),
					UPSTREAM_CONNECT_VARIANTS.map((variant) => jsx(ConnectVariantPanel, {
						variant,
						reasoning,
						t
					}, variant.key))
				]
			});
		}
		//#endregion

		//#region src/reasoning-filter.js
		/**
		 * 「推理等级」按钮不进输入框：检测只在设置页做。
		 *
		 * 上游输入框按钮的可见性完全由它自己的 status 路由决定：
		 * `visible = probe.candidates.includes(model) || results 里有记录`。
		 * 上游路由不能注册两次、它的组件也不接受外部状态，所以这里在本页面包装一次
		 * `window.fetch`：只拦截上游 status 的 GET，把 `candidates` / `results` 清空再交回 ——
		 * 按钮永远不出现。检测到的档位由宿主侧注入模型描述符，选择器照常显示档位下拉。
		 *
		 * 纪律：
		 *   - 只碰这两个已知路径、只碰 JSON 文档；任何一步对不上就原样放行；
		 *   - 本插件的推理档位共享关闭 / 状态读不到时一律放行（fail-open，等于原生行为）；
		 *   - 上游 probe 路由的 POST 会把本地缓存标脏，下一次 status 拦截强制重读开关状态。
		 */
		const REASONING_FILTER_GLOBAL = Symbol.for("dsh-workbuddy-multi:reasoning-filter");
		const REASONING_KNOWN_MIN_INTERVAL_MS = 15000;
		const UPSTREAM_STATUS_PATH_VARIANT = {
			"/plugins/dsh-workbuddy-connect/status": "cn",
			"/plugins/dsh-workbuddy-connect/ai/status": "ai"
		};
		const UPSTREAM_PROBE_PATH_SET = new Set([
			"/plugins/dsh-workbuddy-connect/probe",
			"/plugins/dsh-workbuddy-connect/ai/probe"
		]);

		function createReasoningFilter() {
			const state = {
				enabled: void 0,
				lastReadAt: 0,
				dirty: true,
				inflight: void 0
			};

			/** 读本插件 status 里的 reasoning.enabled 开关；失败保留旧值（fail-open）。 */
			const refreshKnown = (originalFetch, force) => {
				if (state.inflight !== void 0) return state.inflight;
				if (force !== true && state.dirty !== true && Date.now() - state.lastReadAt < REASONING_KNOWN_MIN_INTERVAL_MS) {
					return Promise.resolve();
				}
				state.inflight = (async () => {
					try {
						const response = await originalFetch(STATUS_PATH, {
							headers: { accept: "application/json" },
							credentials: "same-origin"
						});
						const value = await response.json().catch(() => void 0);
						const reasoning = value !== null && typeof value === "object" && value !== void 0 ? value.reasoning : void 0;
						if (reasoning !== null && typeof reasoning === "object" && reasoning !== void 0) {
							state.enabled = reasoning.enabled === true;
							state.lastReadAt = Date.now();
							state.dirty = false;
						}
					} catch {
						/* 读不到就不过滤 */
					} finally {
						state.inflight = void 0;
					}
				})();
				return state.inflight;
			};

			/** 只拦这两个路径：candidates / results 清空，按钮永不在输入框出现。 */
			const filterDocument = (variantKey, value) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
				const probe = value.probe;
				if (typeof probe !== "object" || probe === null || Array.isArray(probe)) return value;
				return { ...value, probe: { ...probe, candidates: [], results: [] } };
			};

			const handle = async (input, init, originalFetch) => {
				let url;
				try {
					const raw = typeof input === "string" ? input : input?.url;
					if (typeof raw !== "string") return originalFetch(input, init);
					url = new URL(raw, window.location.href);
				} catch {
					return originalFetch(input, init);
				}
				if (url.origin !== window.location.origin) return originalFetch(input, init);
				const method = typeof init?.method === "string" ? init.method.toUpperCase() : "GET";
				if (method !== "GET" && UPSTREAM_PROBE_PATH_SET.has(url.pathname)) {
					state.dirty = true;
					return originalFetch(input, init);
				}
				const variantKey = method === "GET" ? UPSTREAM_STATUS_PATH_VARIANT[url.pathname] : void 0;
				if (variantKey === void 0) return originalFetch(input, init);
				const response = await originalFetch(input, init);
				if (!response.ok) return response;
				let value;
				try {
					value = await response.clone().json();
				} catch {
					return response;
				}
				await refreshKnown(originalFetch);
				if (state.enabled !== true) return response;
				const filtered = filterDocument(variantKey, value);
				const headers = new Headers(response.headers);
				headers.delete("content-length");
				headers.delete("content-encoding");
				return new Response(JSON.stringify(filtered), {
					status: response.status,
					statusText: response.statusText,
					headers
				});
			};

			return { state, handle, refreshKnown, filterDocument };
		}

		/** 安装一次（全局符号幂等）；返回还原函数。没有 window/fetch 的环境（测试、SSR）返回空操作。 */
		function installReasoningFilter() {
			if (typeof window === "undefined" || typeof window.fetch !== "function") return () => {};
			const existing = globalThis[REASONING_FILTER_GLOBAL];
			if (existing !== void 0) return existing.dispose;
			const originalFetch = window.fetch.bind(window);
			const filter = createReasoningFilter();
			const wrapped = (input, init) => filter.handle(input, init, originalFetch);
			window.fetch = wrapped;
			const dispose = () => {
				if (window.fetch === wrapped) window.fetch = originalFetch;
				try {
					delete globalThis[REASONING_FILTER_GLOBAL];
				} catch {
					globalThis[REASONING_FILTER_GLOBAL] = void 0;
				}
			};
			globalThis[REASONING_FILTER_GLOBAL] = { dispose, original: originalFetch };
			return dispose;
		}
		//#endregion

		//#region src/client/index.js
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-multi-client";

		/**
		 * Client services required by this browser half.
		 *
		 * `slots` lives in `@deepseek-ai/dsh-client-ui-renderer` and `locale` in
		 * `@deepseek-ai/dsh-client-locale`. Neither slot owner is named here on purpose:
		 * `settings.plugin.item`'s declarer is absent from DSH 0.1.6+ hosts and
		 * `plugins.bundle.config`'s declarer is absent from 0.1.5 hosts, and
		 * `ctx.slots.inject` fires whenever the declaring package commits the slot —
		 * before or after this fiber starts.
		 */
		const inject = ["slots", "locale", "remote", "remote.session"];

		/** Prefix every guarded client contribution's degradation log with this. */
		const CLIENT_CONTRIBUTION_FAILED = "[dsh-workbuddy-multi] client contribution failed to load (host provider unaffected):";

		/** Disposer handed back when a deferred registration degraded: nothing to undo. */
		const NOOP_DISPOSER = () => {};

		/**
		 * Run ONE browser-side contribution, degrading its failure to a `console.error`
		 * instead of throwing into the DSH loader.
		 *
		 * Each contribution is guarded at both boundaries where it can throw: the eager
		 * `ctx.slots.inject(...)` call inside `apply()`, and the deferred callback the
		 * slot runtime invokes later. The pair is what makes the contributions
		 * independent — a broken Plugins-page seam leaves the settings card intact, and
		 * the card leaves the rest of this half intact.
		 */
		function guardClientContribution(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error);
				return void 0;
			}
		}

		/**
		 * Register the card copy and both settings-surface seams, one guarded
		 * contribution at a time.
		 *
		 * The two seams are registered the way upstream registers its own: the
		 * settings-tab card under `settings.plugin.item`, and the Plugins-page config
		 * surface under `plugins.bundle.config` keyed by the bundle's package name (the
		 * key has to spell exactly what the profile installs).
		 */
		function apply(ctx) {
			const namespace = "settings.workbuddyMulti";

			guardClientContribution("settings copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-workbuddy-multi: settings copy");
			});

			/** Host translation, falling back to this half's own table then to the key. */
			const translate = (key, params) => {
				let text;
				try {
					text = ctx.locale.bind(namespace)(key);
				} catch (error) {
					console.error(`${CLIENT_CONTRIBUTION_FAILED} translate("${key}")`, error);
					text = void 0;
				}
				if (text === void 0 || text === null || text === "") text = defaultTranslate(key);
				return interpolate(String(text), params);
			};

			/*
			 * Page-load dependency check: if dsh-workbuddy-connect is not running, install
			 * it through the plugin market and say so in a small notice. Deferred so it
			 * never competes with the page's own startup requests, and skipped where there
			 * is no real window (tests, SSR).
			 */
			guardClientContribution("upstream check", () => {
				ensureUiCss();
				if (typeof window.setTimeout !== "function") return;
				const stopToast = startUpstreamToast(translate);
				const timer = window.setTimeout(() => {
					void upstreamGate.ensure({ auto: true });
				}, UPSTREAM_CHECK_DELAY_MS);
				ctx.effect(() => () => {
					window.clearTimeout(timer);
					stopToast();
				}, "dsh-workbuddy-multi: upstream check");
			});

			/*
			 * 「推理等级」按钮的隐藏：包装本页 fetch，把本插件已知（任一账号检测过）的
			 * 模型从上游 status 的 probe.candidates / probe.results 里过滤掉。
			 * 与服务端的档位注入配对：那边让选择器直接显示档位，这边让按钮消失。
			 */
			guardClientContribution("reasoning effort filter", () => {
				const dispose = installReasoningFilter();
				ctx.effect(() => () => {
					dispose();
				}, "dsh-workbuddy-multi: reasoning effort filter");
			});

			guardClientContribution("settings.plugin.item card", () => {
				ctx.slots.inject("settings.plugin.item", () => guardClientContribution("settings.plugin.item card", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: BUNDLE_NAME,
					priority: 29,
					inject: () => ({ t: translate })
				}, WorkBuddyMultiCard)) ?? NOOP_DISPOSER);
			});

			guardClientContribution("plugins.bundle.config page", () => {
				ctx.slots.inject("plugins.bundle.config", () => guardClientContribution("plugins.bundle.config page", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: BUNDLE_NAME,
					locale: namespace
				}, WorkBuddyMultiConfigPage)) ?? NOOP_DISPOSER);
			});

			/**
			 * The merged group's credit total, in the composer.
			 *
			 * Registered on the same slot upstream uses for its own credit chip, at
			 * `order: 11` so ours sits to its right — two chips, two different questions,
			 * deliberately both visible. See the `src/credits.js` header for why the
			 * upstream one cannot be reused or replaced.
			 */
			guardClientContribution("conversation credits chip", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guardClientContribution("conversation credits chip", () => {
						scope.slots.inject("conversation.input.right", () => guardClientContribution("conversation credits chip", () => scope.slots.register({
							name: "conversation.input.right",
							id: "workbuddy-multi-credits",
							order: 11,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t: translate
							})
						}, CreditsChip)) ?? NOOP_DISPOSER);
					});
				});
			});
		}
		//#endregion

		exports.BUNDLE_NAME = BUNDLE_NAME;
		exports.BUNDLE_BASE = BUNDLE_BASE;
		exports.STATUS_PATH = STATUS_PATH;
		exports.ACTION_PATH = ACTION_PATH;
		exports.ACTIONS = ACTIONS;
		/**
		 * Pure credit helpers, exposed so they can be asserted without a DOM.
		 *
		 * Rendering tests can only observe what ends up in the tree; the interesting
		 * decisions here are the ones made *before* an element exists — `unlimited`
		 * outranking a total, 未知 never being spelled 0, a chip that must not render at
		 * all. Those are worth pinning directly, and the host's test file is the only
		 * place they can be pinned.
		 *
		 * ⚠️ **这不是宿主 API，别当契约依赖。** 它只为本仓库的测试而导出；形状可变、
		 * 名字可改，改动不视为破坏性变更。宿主侧请只用 `dsh.client` 清单里声明的入口。
		 */
		exports.creditsInternals = {
			CREDIT_VARIANT_KEYS,
			CREDITS_CSS,
			CREDITS_CSS_TAG,
			BASE_ROUTE_VARIANT,
			CREDIT_ERROR_KEYS,
			providerOf,
			variantKeyForProvider,
			isMergedMode,
			creditsFor,
			formatCreditTotal,
			creditAccountValue,
			creditSummaryText,
			creditChipLabel,
			creditTooltip,
			chipVariantKey,
			creditsStale,
			CreditsChip
		};
		/** ⚠️ 同上：只为本仓库测试导出，不是宿主 API。 */
		exports.uiInternals = { createUpstreamGate, upstreamGate, UPSTREAM_REPO_URL, UI_CSS };
		/** ⚠️ 同上：只为本仓库测试导出，不是宿主 API。 */
		exports.connectInternals = {
			UPSTREAM_CONNECT_VARIANTS,
			UPSTREAM_UPDATE_PATH,
			isUpstreamStatus,
			connectCreditsText,
			formatWindow,
			createReasoningFilter,
			installReasoningFilter,
			upstreamFetch,
			REASONING_FILTER_GLOBAL
		};

		/**
		 * The locale dictionaries, exposed so copy can be asserted as copy.
		 *
		 * Without them a test can only pin which *keys* were asked for, so a broken
		 * placeholder (`{totl}`) or a missing key in one language would pass every
		 * assertion while rendering a raw `{totl}` to the user. The host's test file uses
		 * these to check both languages resolve and interpolate.
		 *
		 * ⚠️ 同 `creditsInternals`：**这不是宿主 API，别当契约依赖**，只为本仓库测试而导出。
		 */
		exports.localeInternals = { DICTIONARIES };
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
