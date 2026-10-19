/**
 * dsh-workbuddy-multi — pinned per-account WorkBuddy model groups.
 *
 * One DSH provider route per pooled account, assembled **entirely** from
 * `dsh-workbuddy-connect`'s public exports. For each account we build our own
 *
 *   new WorkBuddyCredentialStore({ variant, desktopPath: pool.snapshotPath(k, uid), refresh })
 *     -> new WorkBuddyUpstreamClient()
 *     -> new WorkBuddyCatalog(fallback)
 *     -> createWorkBuddyShim({ store, client, catalog, logger })
 *     -> createWorkBuddyAdapter({ providerId, displayName, region, shim, store, catalog })
 *     -> ctx.llm.registerAdapter([providerId], adapter.adapter)
 *
 * which is exactly how the upstream bundle wires its own two variants in
 * `startVariant()` (`lib/index.js:2106-2138`). No upstream file is patched.
 *
 * Two places the upstream wiring cannot be copied verbatim:
 *
 * 1. The route id. Upstream registers `variant.id` (`workbuddy` / `workbuddy-ai`)
 *    and pi-ai rejects a second registration of a live route with
 *    `DUPLICATE_ADAPTER`, so this module refuses to register anything in that
 *    reserved set. Its own route ids are namespaced (`<prefix><slug>`).
 * 2. `ownPath`. `workbuddyOwnAuthPath()` takes no arguments and resolves to one
 *    file per Harness home, so every pinned store is given its own explicit
 *    `ownPath` — otherwise all accounts would share the upstream plugin's
 *    own-credential copy and flap it back and forth on refresh.
 *
 * `WorkBuddyVariant` is documented as a public type whose callers "construct
 * their own descriptors", so each account gets a derived descriptor: the same
 * `region` / `electron` / env wiring as the variant it belongs to, but our `id`
 * and `displayName`.
 *
 * The credential snapshot is repointed at `pool.snapshotPath()`; the store's
 * `readDesktop()` has no cache, so a re-captured account takes effect on the
 * next request without rebuilding anything here.
 */

import os from "node:os";
import path from "node:path";

/** Default namespace for pinned route ids. */
export const DEFAULT_PROVIDER_PREFIX = "workbuddy-m-";

/**
 * Route ids the upstream plugin owns. Registering any of these would be
 * rejected by pi-ai with `DUPLICATE_ADAPTER`.
 */
export const BASELINE_PROVIDER_IDS = Object.freeze(["workbuddy", "workbuddy-ai"]);

/**
 * The two upstream variants, as (key, base route id, model-group stem). The
 * base route id is only ever used to *look up* the upstream variant descriptor,
 * never to register anything.
 */
export const PINNED_VARIANT_SPECS = Object.freeze([
	Object.freeze({ key: "cn", baseProviderId: "workbuddy", stem: "WorkBuddy" }),
	Object.freeze({ key: "ai", baseProviderId: "workbuddy-ai", stem: "WorkBuddy AI" })
]);

/** A route id has to survive being used as a provider key. */
const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Upstream exports this module cannot work without. */
const REQUIRED_UPSTREAM_EXPORTS = Object.freeze([
	"WorkBuddyCredentialStore",
	"WorkBuddyUpstreamClient",
	"WorkBuddyCatalog",
	"createWorkBuddyShim",
	"createWorkBuddyAdapter"
]);

/** A pinned-routes failure with a stable, testable code. */
export class PinnedRouteError extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.name = "PinnedRouteError";
		this.code = code;
	}
}

const SILENT_LOGGER = Object.freeze({
	info() {},
	warn() {},
	error() {}
});

/**
 * A route id's slug: the first eight characters of the account uid, with
 * everything that is not alphanumeric removed, lowercased. Matches PLAN §3.2.
 *
 * @param {unknown} uid
 * @returns {string} `''` when the uid carries nothing usable.
 */
function accountSlug(uid) {
	if (typeof uid !== "string") return "";
	return uid.slice(0, 8).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** The Harness home, mirroring the upstream default. */
function harnessHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
	return path.join(os.homedir(), ".dsh");
}

/**
 * The route id for one pinned account: `${prefix}${slug}`.
 *
 * Pure. Throws rather than returning a value that must not be registered, so a
 * bad id can never reach `ctx.llm.registerAdapter` by accident.
 *
 * @param {'cn'|'ai'} variantKey
 * @param {{uid?: string}} meta
 * @param {string} [prefix] defaults to {@link DEFAULT_PROVIDER_PREFIX}
 * @returns {string}
 */
export function pinnedProviderId(variantKey, meta, prefix = DEFAULT_PROVIDER_PREFIX) {
	const uid = meta?.uid;
	const slug = accountSlug(uid);
	if (slug === "") {
		throw new PinnedRouteError(
			"missing-uid",
			`cannot pin a ${variantKey} account without a uid (got ${JSON.stringify(uid)})`
		);
	}
	const namespace = typeof prefix === "string" ? prefix : DEFAULT_PROVIDER_PREFIX;
	const providerId = `${namespace}${slug}`;
	assertPinnedProviderId(providerId, BASELINE_PROVIDER_IDS);
	if (!ROUTE_ID_PATTERN.test(providerId)) {
		throw new PinnedRouteError(
			"invalid-provider-id",
			`${JSON.stringify(providerId)} is not a usable route id`
		);
	}
	return providerId;
}

/**
 * Refuse a route id that someone else already owns.
 *
 * `reserved` is compared case-insensitively: a differently-cased duplicate of a
 * live route is a different string but the same mistake waiting to happen.
 *
 * @param {string} providerId
 * @param {Iterable<string>} [reserved]
 * @returns {string} the accepted id, for chaining
 */
export function assertPinnedProviderId(providerId, reserved = BASELINE_PROVIDER_IDS) {
	const taken = new Set();
	for (const id of BASELINE_PROVIDER_IDS) taken.add(String(id).toLowerCase());
	for (const id of reserved ?? []) taken.add(String(id).toLowerCase());
	if (taken.has(String(providerId).toLowerCase())) {
		throw new PinnedRouteError(
			"reserved-provider-id",
			`route id ${JSON.stringify(providerId)} is owned by another provider; refusing to register it`
		);
	}
	return providerId;
}

/**
 * The model-group name for one pinned account: `WorkBuddy · <label>` or
 * `WorkBuddy AI · <label>`. Matches PLAN §3.2.
 *
 * Pure. Falls back to the uid's first eight characters when the pool has no
 * label yet, so a group never renders as an empty heading.
 *
 * @param {'cn'|'ai'} variantKey
 * @param {{label?: string, uid?: string}} meta
 * @returns {string}
 */
export function pinnedDisplayName(variantKey, meta) {
	const stem = variantKey === "ai" ? "WorkBuddy AI" : "WorkBuddy";
	const label = typeof meta?.label === "string" ? meta.label.trim() : "";
	const fallback = typeof meta?.uid === "string" ? meta.uid.slice(0, 8) : "";
	return `${stem} · ${label === "" ? fallback : label}`;
}

/**
 * Per-account pinned routes, reconciled against the account pool.
 *
 * Frozen interface (PLAN §3.2): `constructor({ pool, ctx, logger, config })`,
 * `sync()`, `dispose()`, `list()`. Everything else is an implementation detail,
 * except these documented `config` extensions (all optional):
 *
 * - `deps` — the upstream export surface; defaults to
 *   `await import('dsh-workbuddy-connect')`. Injectable so tests never build a
 *   real loopback shim or touch the filesystem.
 * - `enable` — `false` reconciles everything away (default `true`).
 * - `providerPrefix` — route-id namespace (default {@link DEFAULT_PROVIDER_PREFIX}).
 * - `ownPathFor(providerId, variantKey, uid)` / `ownDir` — per-account upstream
 *   own-credential file (default `<DSH_HOME>/workbuddy-multi/own/<providerId>.json`).
 * - `visible` — whether the pinned catalogs are exposed (default `true`; upstream
 *   hides a catalog until it has a credential, but a pinned account *is* one).
 * - `useMaximumContextWindow` — forwarded to non-CN catalogs, like upstream.
 * - `fallbackModelsFor(variantKey, deps)` — the static roster served before the
 *   first successful upstream fetch.
 * - `reservedProviderIds` — extra ids to treat as taken.
 */
export class PinnedRoutes {
	/**
	 * @param {{pool: object, ctx: object, logger?: object, config?: object}} options
	 */
	constructor({ pool, ctx, logger, config } = {}) {
		if (pool === undefined || pool === null) {
			throw new PinnedRouteError("missing-pool", "PinnedRoutes requires a pool");
		}
		this.pool = pool;
		this.ctx = ctx;
		this.logger = logger ?? ctx?.logger ?? SILENT_LOGGER;
		this.config = config ?? {};
		this.prefix = this.config.providerPrefix ?? DEFAULT_PROVIDER_PREFIX;
		/** @type {Map<string, object>} providerId -> live entry */
		this.entries = new Map();
		/** @type {{code: string, message: string}[]} */
		this.warnings = [];
		this._deps = this.config.deps ?? undefined;
		this._variants = undefined;
		this._reserved = undefined;
	}

	/**
	 * Whether pinned routes should exist right now. Re-read on every call so a
	 * live settings toggle takes effect without rebuilding the object; assigning
	 * it is shorthand for writing `config.enable`.
	 */
	get enabled() {
		return this.config.enable !== false;
	}

	set enabled(value) {
		this.config.enable = value !== false;
	}

	/** The pinned routes currently registered. Never throws, even mid-teardown. */
	list() {
		return [...this.entries.values()].map((entry) => ({
			providerId: entry.providerId,
			variantKey: entry.variantKey,
			uid: entry.uid,
			displayName: entry.displayName
		}));
	}

	/**
	 * Reconcile the registered routes with the account pool: add one route per
	 * enabled account, retire routes whose account disappeared or was disabled,
	 * and rebuild a route whose model-group name changed.
	 *
	 * Per-account failures are contained: a broken account is recorded in
	 * `warnings` and skipped, and every other account still comes up.
	 *
	 * @returns {Promise<{added: number, removed: number, rebuilt: number, warnings: object[], entries: object[]}>}
	 */
	async sync() {
		this.warnings = [];
		if (!this.enabled) {
			// Nothing to register. Retire leftovers — and crucially do NOT resolve the
			// upstream module: a disabled plugin has to work on a machine where
			// `dsh-workbuddy-connect` was never installed.
			let removed = 0;
			for (const entry of [...this.entries.values()]) {
				await this._retire(entry, "disabled");
				removed += 1;
			}
			if (removed > 0) this._notifyAdaptersUpdated();
			return { added: 0, removed, rebuilt: 0, warnings: [...this.warnings], entries: this.list() };
		}
		const deps = await this._resolveDeps();

		/** @type {Map<string, {variantKey: string, meta: object, providerId: string, displayName: string}>} */
		const desired = new Map();
		for (const spec of PINNED_VARIANT_SPECS) {
			if (!this._variants.has(spec.key)) continue;
			for (const meta of this._listAccounts(spec.key)) {
				if (meta?.enabled !== true) continue;
				let providerId;
				try {
					providerId = pinnedProviderId(spec.key, meta, this.prefix);
					assertPinnedProviderId(providerId, this._reserved);
				} catch (error) {
					this._warn(error?.code ?? "provider-id-rejected", `${spec.key}: ${error?.message ?? error}`);
					continue;
				}
				if (desired.has(providerId)) {
					this._warn(
						"duplicate-provider-id",
						`${providerId} was produced by two accounts; keeping the first, skipping uid ${meta.uid}`
					);
					continue;
				}
				desired.set(providerId, {
					variantKey: spec.key,
					meta,
					providerId,
					displayName: pinnedDisplayName(spec.key, meta)
				});
			}
		}

		let added = 0;
		let removed = 0;
		let rebuilt = 0;

		// Retire first: an account that vanished, or whose group was renamed.
		for (const entry of [...this.entries.values()]) {
			const want = desired.get(entry.providerId);
			if (want === undefined) {
				await this._retire(entry, "removed");
				removed += 1;
				continue;
			}
			if (want.displayName !== entry.displayName || want.meta.uid !== entry.uid) {
				await this._retire(entry, "renamed");
				rebuilt += 1;
			}
		}

		for (const want of desired.values()) {
			if (this.entries.has(want.providerId)) continue;
			try {
				await this._create(deps, want);
				added += 1;
			} catch (error) {
				this._warn(
					"create-failed",
					`${want.providerId} (${want.variantKey} ${want.meta.uid}) could not be pinned: ${error?.message ?? error}`
				);
				this.logger?.warn?.(`dsh-workbuddy-multi: pinned route ${want.providerId} failed`, error);
			}
		}

		if (added > 0 || removed > 0 || rebuilt > 0) this._notifyAdaptersUpdated();

		return { added, removed, rebuilt, warnings: [...this.warnings], entries: this.list() };
	}

	/**
	 * Close every pinned shim and release every adapter registration. Idempotent,
	 * and a later `sync()` rebuilds from scratch — so it is safe to call on a
	 * settings change and not only on unload.
	 *
	 * @returns {Promise<number>} how many routes were torn down
	 */
	async dispose() {
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const entry of entries) await this._retire(entry, "dispose");
		if (entries.length > 0) this._notifyAdaptersUpdated();
		return entries.length;
	}

	/** Resolve and validate the upstream export surface (once). */
	async _resolveDeps() {
		if (this._deps === undefined) {
			// `config.deps` overrides the bare import for tests and for hosts that
			// resolve the upstream module themselves; read it here, not in the
			// constructor, so assigning it late still counts.
			this._deps = this.config.deps ?? (await import("dsh-workbuddy-connect"));
		}
		const deps = this._deps;
		const missing = REQUIRED_UPSTREAM_EXPORTS.filter((name) => typeof deps?.[name] !== "function");
		if (missing.length > 0) {
			throw new PinnedRouteError(
				"missing-upstream-export",
				`dsh-workbuddy-connect does not export ${missing.join(", ")}; pinned routes cannot be built`
			);
		}
		if (this._variants === undefined) this._variants = this._resolveVariants(deps);
		if (this._reserved === undefined) this._reserved = this._resolveReserved(deps);
		return deps;
	}

	/**
	 * The upstream variant descriptors we derive per-account descriptors from.
	 * Missing variants are skipped with a warning: a future upstream that drops
	 * one must not take the other down with it.
	 */
	_resolveVariants(deps) {
		const declared = Array.isArray(deps.WORKBUDDY_VARIANTS) ? deps.WORKBUDDY_VARIANTS : [];
		const byId = new Map();
		for (const variant of declared) {
			if (typeof variant?.id === "string") byId.set(variant.id, variant);
		}
		for (const fallback of [deps.CN_VARIANT, deps.AI_VARIANT]) {
			if (typeof fallback?.id === "string" && !byId.has(fallback.id)) byId.set(fallback.id, fallback);
		}
		const resolved = new Map();
		for (const spec of PINNED_VARIANT_SPECS) {
			const base = byId.get(spec.baseProviderId);
			if (base === undefined) {
				this._warn(
					"missing-upstream-variant",
					`dsh-workbuddy-connect declares no ${spec.baseProviderId} variant; its accounts stay unpinned`
				);
				continue;
			}
			resolved.set(spec.key, { spec, base });
		}
		return resolved;
	}

	/** Ids that must never be registered: the upstream routes, then any extra. */
	_resolveReserved(deps) {
		const reserved = [...BASELINE_PROVIDER_IDS];
		const declared = Array.isArray(deps.WORKBUDDY_VARIANTS) ? deps.WORKBUDDY_VARIANTS : [];
		for (const variant of declared) {
			if (typeof variant?.id === "string") reserved.push(variant.id);
		}
		for (const id of this.config.reservedProviderIds ?? []) reserved.push(id);
		return reserved;
	}

	/** The pool's own account list; a pool hiccup must not stop the other variants. */
	_listAccounts(variantKey) {
		try {
			const list = this.pool.list(variantKey);
			return Array.isArray(list) ? list : [];
		} catch (error) {
			this._warn("pool-list-failed", `${variantKey}: ${error?.message ?? error}`);
			return [];
		}
	}

	/** The static roster a pinned catalog serves before its first fetch. */
	_fallbackModels(deps, variantKey) {
		const override = this.config.fallbackModelsFor;
		if (typeof override === "function") return override(variantKey, deps);
		// Mirrors the upstream fallbackFor(): CN and AI have different rosters.
		const list = variantKey === "cn" ? deps.FALLBACK_WORKBUDDY_MODELS : deps.FALLBACK_WORKBUDDY_AI_MODELS;
		return Array.isArray(list) ? list : [];
	}

	/** One account's upstream own-credential file. Never the shared upstream one. */
	_ownPathFor(providerId, variantKey, uid) {
		const override = this.config.ownPathFor;
		if (typeof override === "function") return override(providerId, variantKey, uid);
		const dir = this.config.ownDir ?? path.join(harnessHome(), "workbuddy-multi", "own");
		return path.join(dir, `${providerId}.json`);
	}

	/** Build one pinned route. Rejects before registering anything it cannot finish. */
	async _create(deps, want) {
		const { variantKey, meta, providerId, displayName } = want;
		const { base } = this._variants.get(variantKey);
		const desktopPath = this.pool.snapshotPath(variantKey, meta.uid);
		if (typeof desktopPath !== "string" || desktopPath === "") {
			throw new PinnedRouteError(
				"missing-snapshot-path",
				`pool.snapshotPath(${variantKey}, ${meta.uid}) returned ${JSON.stringify(desktopPath)}`
			);
		}

		// Derived descriptor: upstream's region/electron/env wiring, our route id.
		const variant = { ...base, id: providerId, displayName, baseProviderId: base.id };
		const client = new deps.WorkBuddyUpstreamClient();
		const store = new deps.WorkBuddyCredentialStore({
			variant,
			desktopPath,
			ownPath: this._ownPathFor(providerId, variantKey, meta.uid),
			refresh: (credential) => client.refreshToken(credential)
		});
		const catalog = new deps.WorkBuddyCatalog(this._fallbackModels(deps, variantKey));
		if (variantKey !== "cn") {
			catalog.setUseMaximumContextWindow?.(this.config.useMaximumContextWindow === true);
		}
		catalog.setVisible?.(this.config.visible !== false);

		const shim = deps.createWorkBuddyShim({ store, client, catalog, logger: this.logger });
		let release;
		let adapter;
		try {
			await shim.ready;
			const assembled = deps.createWorkBuddyAdapter({
				providerId,
				displayName,
				region: base.region,
				shim,
				store,
				catalog
			});
			adapter = assembled?.adapter ?? assembled;
			release = this.ctx?.llm?.registerAdapter([providerId], adapter);
			if (typeof release !== "function") {
				throw new PinnedRouteError(
					"register-adapter-unsupported",
					"ctx.llm.registerAdapter did not return a release function"
				);
			}
		} catch (error) {
			// Never leak a listening loopback socket on a failed account.
			await this._closeQuietly(shim);
			throw error;
		}

		this.entries.set(providerId, {
			providerId,
			variantKey,
			uid: meta.uid,
			displayName,
			variant,
			store,
			client,
			catalog,
			shim,
			adapter,
			release
		});
	}

	/** Release the adapter, then close the shim. Both failures are contained. */
	async _retire(entry, reason) {
		this.entries.delete(entry.providerId);
		try {
			entry.release?.();
		} catch (error) {
			this._warn("release-failed", `${entry.providerId} (${reason}): ${error?.message ?? error}`);
		}
		await this._closeQuietly(entry.shim, entry.providerId, reason);
	}

	async _closeQuietly(shim, providerId, reason) {
		if (typeof shim?.close !== "function") return;
		try {
			await shim.close();
		} catch (error) {
			this._warn(
				"shim-close-failed",
				`${providerId ?? "unregistered route"}${reason === undefined ? "" : ` (${reason})`}: ${error?.message ?? error}`
			);
		}
	}

	/** Additions and removals change the picker's route list. */
	_notifyAdaptersUpdated() {
		try {
			this.ctx?.emit?.("llm/adapters-updated");
		} catch (error) {
			this._warn("emit-failed", `${error?.message ?? error}`);
		}
	}

	_warn(code, message) {
		this.warnings.push({ code, message });
		this.logger?.warn?.(`dsh-workbuddy-multi: ${message}`);
	}
}
