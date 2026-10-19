/**
 * Unit tests for lib/pinned.js.
 *
 * Everything upstream is faked: no loopback shim is ever started, no CN
 * encrypted envelope is ever parsed, and no file is read or written. The pool is
 * a stub exposing only the PLAN §3.2 frozen methods this module is allowed to
 * use (`list`, `snapshotPath`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BASELINE_PROVIDER_IDS,
	DEFAULT_PROVIDER_PREFIX,
	PinnedRouteError,
	PinnedRoutes,
	assertPinnedProviderId,
	pinnedDisplayName,
	pinnedProviderId
} from "../lib/pinned.js";

/* ------------------------------------------------------------------ fakes */

/** Upstream variant docs, mirroring the real 0.7.8 values (AI region is 'global'). */
function baseVariants(extra = []) {
	return [
		{
			id: "workbuddy",
			displayName: "WorkBuddy",
			appName: "WorkBuddy",
			region: "cn",
			env: "WORKBUDDY_AUTH_FILE",
			desktopFilename: "workbuddy-desktop.info",
			ownFilename: ".workbuddy-auth.json",
			probeFilename: ".workbuddy-probe.json",
			catalogFilename: ".workbuddy-catalog.json",
			visibilityFilename: ".workbuddy-visibility.json",
			electron: { binary: "WorkBuddy" }
		},
		{
			id: "workbuddy-ai",
			displayName: "WorkBuddy AI",
			appName: "WorkBuddy AI",
			region: "global",
			env: "WORKBUDDY_AI_AUTH_FILE",
			desktopFilename: "workbuddy-desktop-ai.info",
			ownFilename: ".workbuddy-auth-ai.json",
			probeFilename: ".workbuddy-probe-ai.json",
			catalogFilename: ".workbuddy-catalog-ai.json",
			visibilityFilename: ".workbuddy-visibility-ai.json",
			electron: { binary: "WorkBuddy AI" }
		},
		...extra
	];
}

/**
 * A fake `dsh-workbuddy-connect` export surface, recording every construction so
 * the tests can assert exactly what pinned.js handed upstream.
 *
 * @param {{failShimIds?: string[], failStoreIds?: string[], extraVariants?: object[]}} [options]
 */
function makeDeps(options = {}) {
	const failShimIds = new Set(options.failShimIds ?? []);
	const failStoreIds = new Set(options.failStoreIds ?? []);
	const calls = { stores: [], clients: 0, catalogs: [], shims: [], adapters: [] };

	class FakeShim {
		constructor(id) {
			this.id = id;
			this.closed = false;
			this.ready = failShimIds.has(id)
				? Promise.reject(new Error(`loopback endpoint failed for ${id}`))
				: Promise.resolve();
		}
		baseUrl() {
			return "http://127.0.0.1:1";
		}
		token() {
			return "shim-token";
		}
		async close() {
			this.closed = true;
		}
	}

	const deps = {
		WORKBUDDY_VARIANTS: baseVariants(options.extraVariants),
		CN_VARIANT: baseVariants()[0],
		AI_VARIANT: baseVariants()[1],
		WORKBUDDY_PROVIDER: "workbuddy",
		FALLBACK_WORKBUDDY_MODELS: [{ id: "cn-model" }],
		FALLBACK_WORKBUDDY_AI_MODELS: [{ id: "ai-model" }],
		WorkBuddyCredentialStore: class {
			constructor(storeOptions) {
				const id = storeOptions.variant?.id;
				if (failStoreIds.has(id)) throw new Error(`cannot decode envelope for ${id}`);
				this.options = storeOptions;
				calls.stores.push(storeOptions);
			}
		},
		WorkBuddyUpstreamClient: class {
			constructor() {
				calls.clients += 1;
			}
			async refreshToken() {
				return { ok: true };
			}
		},
		WorkBuddyCatalog: class {
			constructor(models) {
				this.models = models;
				this.visible = true;
				this.maximumContextWindow = false;
				calls.catalogs.push(this);
			}
			current() {
				return this.visible ? this.models : [];
			}
			setVisible(visible) {
				const changed = this.visible !== visible;
				this.visible = visible;
				return changed;
			}
			setUseMaximumContextWindow(useMaximum) {
				const changed = this.maximumContextWindow !== useMaximum;
				this.maximumContextWindow = useMaximum;
				return changed;
			}
		},
		createWorkBuddyShim(shimOptions) {
			const shim = new FakeShim(shimOptions.store?.options?.variant?.id);
			shim.options = shimOptions;
			calls.shims.push(shim);
			return shim;
		},
		createWorkBuddyAdapter(adapterOptions) {
			calls.adapters.push(adapterOptions);
			return {
				adapter: { routeId: adapterOptions.providerId, options: adapterOptions },
				invalidate() {}
			};
		}
	};
	return { deps, calls };
}

/** A pool stub exposing only the frozen methods pinned.js may call. */
function makePool(accounts) {
	const snapshotRoot = "/pool/accounts";
	return {
		list(variantKey) {
			return accounts[variantKey] ?? [];
		},
		snapshotPath(variantKey, uid) {
			return `${snapshotRoot}/${variantKey}/${uid}.info`;
		}
	};
}

/** A ctx stub whose registerAdapter records calls and hands back a release fn. */
function makeCtx() {
	const registrations = [];
	const events = [];
	const ctx = {
		llm: {
			registerAdapter(ids, adapter) {
				const record = { ids: [...ids], adapter, released: false };
				registrations.push(record);
				return () => {
					if (record.released) throw new Error(`released twice: ${record.ids.join(",")}`);
					record.released = true;
				};
			}
		},
		emit(name) {
			events.push(name);
		},
		logger: { info() {}, warn() {}, error() {} }
	};
	return { ctx, registrations, events };
}

function meta(uid, over = {}) {
	return {
		variantKey: over.variantKey ?? "cn",
		uid,
		uin: "100000000001",
		domain: "www.workbuddy.cn",
		label: uid,
		enabled: true,
		...over
	};
}

/* ------------------------------------------------------- pure: route ids */

/** Assert that a thunk throws a PinnedRouteError with an exact code. */
function throwsCode(code) {
	return (error) => {
		assert.ok(error instanceof PinnedRouteError, `expected a PinnedRouteError, got ${error}`);
		assert.equal(error.code, code);
		return true;
	};
}

test("pinnedProviderId namespaces the uid's first 8 chars, lowercased, alnum-only", () => {
	assert.equal(DEFAULT_PROVIDER_PREFIX, "workbuddy-m-");
	assert.equal(pinnedProviderId("cn", { uid: "5F1E0C3A-7b2d-4e9f-8a61-0c4d2b7e9f13" }), "workbuddy-m-5f1e0c3a");
	assert.equal(pinnedProviderId("ai", { uid: "8C3D9E21-4a5b-4c6d-9e7f-1a2b3c4d5e6f" }), "workbuddy-m-8c3d9e21");
	// Exactly eight uid *characters* participate; separators inside them are
	// stripped rather than back-filled, which is what PLAN §3.2 specifies.
	assert.equal(pinnedProviderId("cn", { uid: "ab-cd-ef-gh" }), "workbuddy-m-abcdef");
	assert.equal(pinnedProviderId("cn", { uid: "abcdefghijkl" }), "workbuddy-m-abcdefgh");
});

test("pinnedProviderId honours an explicit prefix, including an empty one", () => {
	assert.equal(pinnedProviderId("cn", { uid: "00112233" }, "wb-x-"), "wb-x-00112233");
	assert.equal(pinnedProviderId("cn", { uid: "00112233" }, ""), "00112233");
	assert.equal(pinnedProviderId("cn", { uid: "00112233" }, undefined), "workbuddy-m-00112233");
});

test("pinnedProviderId refuses an account with no usable uid", () => {
	assert.throws(() => pinnedProviderId("cn", {}), throwsCode("missing-uid"));
	assert.throws(() => pinnedProviderId("cn", { uid: "--------" }), throwsCode("missing-uid"));
	assert.throws(() => pinnedProviderId("cn", null), throwsCode("missing-uid"));
});

test("the baseline route ids are refused — the upstream plugin owns them", () => {
	for (const id of BASELINE_PROVIDER_IDS) {
		assert.throws(() => assertPinnedProviderId(id), throwsCode("reserved-provider-id"));
	}
	// A differently-cased duplicate is the same mistake; reject it too.
	assert.throws(() => assertPinnedProviderId("WorkBuddy"), throwsCode("reserved-provider-id"));
	// A namespace that happens to rebuild a baseline id is caught at computation.
	const rebuilt = `${"workbudd"}${"y-------".slice(0, 8).replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
	assert.equal(rebuilt, "workbuddy");
	assert.throws(() => pinnedProviderId("cn", { uid: "y-------" }, "workbudd"), throwsCode("reserved-provider-id"));
	// Any other owner in the registry is refused as well.
	assert.throws(
		() => assertPinnedProviderId("workbuddy-m-deadbeef", ["workbuddy-m-deadbeef"]),
		throwsCode("reserved-provider-id")
	);
	assert.equal(assertPinnedProviderId("workbuddy-m-deadbeef", []), "workbuddy-m-deadbeef");
});

test("pinnedProviderId rejects an id that cannot be a provider key", () => {
	assert.throws(() => pinnedProviderId("cn", { uid: "00112233" }, "bad prefix "), throwsCode("invalid-provider-id"));
	assert.throws(() => pinnedProviderId("cn", { uid: "00112233" }, "-leading"), throwsCode("invalid-provider-id"));
});

/* ---------------------------------------------------- pure: group names */

test("pinnedDisplayName renders the PLAN §3.2 model-group names", () => {
	assert.equal(pinnedDisplayName("cn", { uid: "5f1e0c3a-7b2d", label: "工作号" }), "WorkBuddy · 工作号");
	assert.equal(pinnedDisplayName("ai", { uid: "8c3d9e21-4a5b", label: "personal" }), "WorkBuddy AI · personal");
	assert.equal(pinnedDisplayName("cn", { uid: "5f1e0c3a-7b2d", label: "  padded  " }), "WorkBuddy · padded");
	// No label yet -> the uid's first eight characters, never an empty heading.
	assert.equal(pinnedDisplayName("cn", { uid: "5f1e0c3a-7b2d" }), "WorkBuddy · 5f1e0c3a");
	assert.equal(pinnedDisplayName("cn", { uid: "5f1e0c3a-7b2d", label: "   " }), "WorkBuddy · 5f1e0c3a");
	assert.equal(pinnedDisplayName("cn", {}), "WorkBuddy · ");
	assert.equal(pinnedDisplayName("cn", undefined), "WorkBuddy · ");
});

/* ------------------------------------------------------------ sync(): add */

test("sync() pins one route per enabled account, wired the way upstream wires its own", async () => {
	const accounts = {
		cn: [meta("5f1e0c3a-7b2d-4e9f-8a61-0c4d2b7e9f13", { label: "CN main" })],
		ai: [meta("8c3d9e21-4a5b-4c6d-9e7f-1a2b3c4d5e6f", { label: "personal", variantKey: "ai" })]
	};
	const { deps, calls } = makeDeps();
	const { ctx, registrations, events } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });

	const summary = await routes.sync();

	assert.deepEqual(registrations.map((r) => r.ids), [["workbuddy-m-5f1e0c3a"], ["workbuddy-m-8c3d9e21"]]);
	assert.equal(summary.added, 2);
	assert.deepEqual(summary.warnings, []);
	assert.deepEqual(routes.list(), [
		{
			providerId: "workbuddy-m-5f1e0c3a",
			variantKey: "cn",
			uid: "5f1e0c3a-7b2d-4e9f-8a61-0c4d2b7e9f13",
			displayName: "WorkBuddy · CN main"
		},
		{
			providerId: "workbuddy-m-8c3d9e21",
			variantKey: "ai",
			uid: "8c3d9e21-4a5b-4c6d-9e7f-1a2b3c4d5e6f",
			displayName: "WorkBuddy AI · personal"
		}
	]);

	// Never a baseline route, and every registered id carries our prefix.
	for (const record of registrations) {
		assert.equal(BASELINE_PROVIDER_IDS.includes(record.ids[0]), false);
		assert.ok(record.ids[0].startsWith(DEFAULT_PROVIDER_PREFIX));
	}
	assert.deepEqual(events, ["llm/adapters-updated"]);

	// The store reads this account's snapshot, and never the shared upstream file.
	const [cnStore, aiStore] = calls.stores;
	assert.equal(cnStore.desktopPath, "/pool/accounts/cn/5f1e0c3a-7b2d-4e9f-8a61-0c4d2b7e9f13.info");
	assert.equal(aiStore.desktopPath, "/pool/accounts/ai/8c3d9e21-4a5b-4c6d-9e7f-1a2b3c4d5e6f.info");
	assert.equal(typeof cnStore.refresh, "function");
	assert.notEqual(cnStore.ownPath, aiStore.ownPath);
	assert.ok(cnStore.ownPath.endsWith("workbuddy-m-5f1e0c3a.json"));
	assert.ok(!cnStore.ownPath.endsWith(".workbuddy-auth.json"), "must not share the upstream own-credential file");

	// Derived descriptor: our id and heading, upstream's region/electron/env wiring.
	assert.equal(cnStore.variant.id, "workbuddy-m-5f1e0c3a");
	assert.equal(cnStore.variant.displayName, "WorkBuddy · CN main");
	assert.equal(cnStore.variant.region, "cn");
	assert.equal(cnStore.variant.env, "WORKBUDDY_AUTH_FILE");
	assert.deepEqual(cnStore.variant.electron, { binary: "WorkBuddy" });
	assert.equal(aiStore.variant.id, "workbuddy-m-8c3d9e21");
	// Upstream's authoritative AI region is 'global', not 'ai'.
	assert.equal(aiStore.variant.region, "global");

	// Catalogs: per-variant fallback roster, and pinned accounts are visible
	// (upstream hides a catalog until it has a credential; a pinned account is one).
	assert.deepEqual(calls.catalogs[0].current(), [{ id: "cn-model" }]);
	assert.equal(calls.catalogs[0].visible, true);
	assert.deepEqual(calls.catalogs[1].current(), [{ id: "ai-model" }]);

	assert.equal(calls.adapters[0].region, "cn");
	assert.equal(calls.adapters[1].region, "global");
	assert.equal(calls.adapters[0].providerId, "workbuddy-m-5f1e0c3a");
	assert.equal(calls.adapters[0].displayName, "WorkBuddy · CN main");
	assert.equal(calls.shims.length, 2);
	assert.equal(calls.shims.every((shim) => shim.closed === false), true);
});

test("sync() ignores disabled accounts and is idempotent", async () => {
	const accounts = {
		cn: [meta("aaaa1111-0000"), meta("bbbb2222-0000", { enabled: false })],
		ai: []
	};
	const { deps, calls } = makeDeps();
	const { ctx, registrations, events } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });

	const first = await routes.sync();
	assert.equal(first.added, 1);
	assert.deepEqual(registrations.map((r) => r.ids[0]), ["workbuddy-m-aaaa1111"]);

	const shimBefore = routes.entries.get("workbuddy-m-aaaa1111").shim;
	const second = await routes.sync();
	assert.equal(second.added, 0);
	assert.equal(second.removed, 0);
	assert.equal(second.rebuilt, 0);
	assert.equal(registrations.length, 1, "a second sync must not re-register");
	assert.equal(calls.stores.length, 1);
	assert.equal(calls.shims.length, 1, "a second sync must not stand up another loopback shim");
	assert.equal(
		routes.entries.get("workbuddy-m-aaaa1111").shim,
		shimBefore,
		"a second sync must not rebuild the live shim"
	);
	assert.deepEqual(events, ["llm/adapters-updated"], "no change, no event");
});

test("list() is total: empty before sync, unchanged by a no-op sync, empty after dispose", async () => {
	const { deps } = makeDeps();
	const routes = new PinnedRoutes({ pool: makePool({ cn: [meta("aaaa1111-0000")], ai: [] }), ctx: makeCtx().ctx, config: { deps } });
	assert.deepEqual(routes.list(), [], "before sync()");

	await routes.sync();
	const listed = routes.list();
	assert.deepEqual(listed, [{ providerId: "workbuddy-m-aaaa1111", variantKey: "cn", uid: "aaaa1111-0000", displayName: "WorkBuddy · " }].map((e) => ({ ...e, displayName: listed[0].displayName })));
	assert.equal(typeof listed[0].displayName, "string");

	await routes.dispose();
	assert.deepEqual(routes.list(), [], "after dispose()");
	await routes.dispose(); // idempotent, and still returns a number
	assert.deepEqual(routes.list(), []);
});

/* --------------------------------------------------- sync(): remove/rename */

test("sync() retires a route whose account was disabled or removed, closing its shim", async () => {
	const accounts = { cn: [meta("aaaa1111-0000"), meta("bbbb2222-0000")], ai: [] };
	const { deps, calls } = makeDeps();
	const { ctx, registrations } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });
	await routes.sync();
	assert.equal(routes.list().length, 2);

	accounts.cn = [meta("aaaa1111-0000"), meta("bbbb2222-0000", { enabled: false })];
	const summary = await routes.sync();

	assert.equal(summary.removed, 1);
	assert.deepEqual(routes.list().map((e) => e.uid), ["aaaa1111-0000"]);
	assert.equal(registrations[1].released, true, "the adapter registration must be released");
	assert.equal(calls.shims[1].closed, true, "the loopback shim must be closed");

	accounts.cn = [];
	const cleared = await routes.sync();
	assert.equal(cleared.removed, 1);
	assert.deepEqual(routes.list(), []);
	assert.equal(registrations[0].released, true);
	assert.equal(calls.shims[0].closed, true);
});

test("sync() rebuilds a route when the account label changes the model-group name", async () => {
	const accounts = { cn: [meta("aaaa1111-0000", { label: "before" })], ai: [] };
	const { deps, calls } = makeDeps();
	const { ctx, registrations } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });
	await routes.sync();

	accounts.cn = [meta("aaaa1111-0000", { label: "after" })];
	const summary = await routes.sync();

	assert.equal(summary.rebuilt, 1);
	assert.equal(summary.added, 1, "the rebuilt route is registered again");
	assert.equal(registrations.length, 2);
	assert.equal(registrations[0].released, true);
	assert.equal(calls.shims[0].closed, true);
	assert.equal(routes.list()[0].displayName, "WorkBuddy · after");
	// Same route id, new adapter — the route id is the account, not the label.
	assert.deepEqual(registrations[1].ids, registrations[0].ids);
	assert.equal(calls.stores[1].variant.displayName, "WorkBuddy · after");
});

/* ------------------------------------------------------ failure isolation */

test("one account failing to come up does not stop the others", async () => {
	const accounts = {
		cn: [meta("aaaa1111-0000", { label: "broken" }), meta("bbbb2222-0000", { label: "healthy" })],
		ai: [meta("cccc3333-0000", { label: "healthy ai", variantKey: "ai" })]
	};
	const { deps, calls } = makeDeps({ failShimIds: ["workbuddy-m-aaaa1111"] });
	const { ctx, registrations } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });

	const summary = await routes.sync();

	assert.equal(summary.added, 2, "the other two accounts still register");
	assert.deepEqual(routes.list().map((e) => e.providerId), ["workbuddy-m-bbbb2222", "workbuddy-m-cccc3333"]);
	assert.deepEqual(registrations.map((r) => r.ids[0]), ["workbuddy-m-bbbb2222", "workbuddy-m-cccc3333"]);
	assert.equal(registrations.every((r) => r.ids[0] !== "workbuddy-m-aaaa1111"), true);
	assert.equal(summary.warnings.length, 1);
	assert.equal(summary.warnings[0].code, "create-failed");
	assert.match(summary.warnings[0].message, /workbuddy-m-aaaa1111/);
	// The failed account's shim was closed rather than leaked (PLAN R5).
	const failedShim = calls.shims.find((shim) => shim.id === "workbuddy-m-aaaa1111");
	assert.equal(failedShim.closed, true);
	// And no adapter was assembled for it.
	assert.equal(calls.adapters.some((a) => a.providerId === "workbuddy-m-aaaa1111"), false);
});

test("a store that cannot decode an account is contained the same way", async () => {
	const accounts = { cn: [meta("aaaa1111-0000"), meta("bbbb2222-0000")], ai: [] };
	const { deps } = makeDeps({ failStoreIds: ["workbuddy-m-aaaa1111"] });
	const { ctx, registrations } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });

	const summary = await routes.sync();

	assert.equal(summary.added, 1);
	assert.deepEqual(registrations.map((r) => r.ids[0]), ["workbuddy-m-bbbb2222"]);
	assert.equal(summary.warnings[0].code, "create-failed");
	assert.match(summary.warnings[0].message, /envelope/);
});

test("an id owned by someone else in the registry is skipped, not registered", async () => {
	// A future upstream release that ships a variant matching our namespace.
	const { deps, calls } = makeDeps({ extraVariants: [{ id: "workbuddy-m-deadbeef", displayName: "Taken", region: "cn" }] });
	const accounts = { cn: [meta("deadbeef-1234")], ai: [] };
	const { ctx, registrations } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });

	const summary = await routes.sync();

	assert.deepEqual(registrations, []);
	assert.deepEqual(routes.list(), []);
	assert.equal(calls.stores.length, 0);
	assert.equal(summary.warnings.length, 1);
	assert.equal(summary.warnings[0].code, "reserved-provider-id");

	// The same account pins fine once nothing else owns the id.
	const extra = new PinnedRoutes({ pool: makePool(accounts), ctx: makeCtx().ctx, config: { deps: makeDeps().deps } });
	await extra.sync();
	assert.deepEqual(extra.list().map((e) => e.providerId), ["workbuddy-m-deadbeef"]);
});

test("an account without a uid is skipped with a warning", async () => {
	const { deps } = makeDeps();
	const accounts = { cn: [meta(""), meta("bbbb2222-0000")], ai: [] };
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx: makeCtx().ctx, config: { deps } });

	const summary = await routes.sync();

	assert.equal(summary.added, 1);
	assert.equal(summary.warnings[0].code, "missing-uid");
});

test("a pool whose list() throws is contained per variant", async () => {
	const { deps } = makeDeps();
	const pool = {
		list(variantKey) {
			if (variantKey === "cn") throw new Error("index.json is unreadable");
			return [meta("cccc3333-0000", { variantKey: "ai" })];
		},
		snapshotPath: (k, uid) => `/pool/${k}/${uid}.info`
	};
	const { ctx, registrations } = makeCtx();
	const routes = new PinnedRoutes({ pool, ctx, config: { deps } });

	const summary = await routes.sync();

	assert.deepEqual(registrations.map((r) => r.ids[0]), ["workbuddy-m-cccc3333"]);
	assert.equal(summary.warnings[0].code, "pool-list-failed");
});

test("a broken upstream export surface fails loudly instead of half-registering", async () => {
	const { deps } = makeDeps();
	delete deps.createWorkBuddyAdapter;
	const routes = new PinnedRoutes({ pool: makePool({ cn: [meta("aaaa1111-0000")] }), ctx: makeCtx().ctx, config: { deps } });

	await assert.rejects(routes.sync(), (error) => {
		assert.ok(error instanceof PinnedRouteError);
		assert.equal(error.code, "missing-upstream-export");
		assert.match(error.message, /createWorkBuddyAdapter/);
		return true;
	});
});

/* ----------------------------------------------------------- enable/dispose */

test("config.enable=false reconciles every pinned route away", async () => {
	const accounts = { cn: [meta("aaaa1111-0000")], ai: [] };
	const { deps, calls } = makeDeps();
	const { ctx, registrations } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });
	await routes.sync();
	assert.equal(routes.list().length, 1);

	routes.config.enable = false; // the path lib/index.js uses for a settings toggle
	assert.equal(routes.enabled, false);
	const summary = await routes.sync();

	assert.equal(summary.removed, 1);
	assert.deepEqual(routes.list(), []);
	assert.equal(registrations[0].released, true);
	assert.equal(calls.shims[0].closed, true);
});

test("config.enable=false never resolves the upstream module", async () => {
	// No `deps` injected: resolving them would import `dsh-workbuddy-connect`,
	// which is not installed beside a bare plugin checkout.
	const routes = new PinnedRoutes({
		pool: makePool({ cn: [meta("aaaa1111-0000")], ai: [] }),
		ctx: makeCtx().ctx,
		config: { enable: false }
	});
	const summary = await routes.sync();
	assert.deepEqual(summary, { added: 0, removed: 0, rebuilt: 0, warnings: [], entries: [] });
	assert.equal(routes._deps, undefined, "a disabled sync must not import upstream");
	assert.deepEqual(routes.list(), []);
	// Re-enabling later still works through the shorthand setter.
	routes.enabled = true;
	const { deps } = makeDeps();
	routes.config.deps = deps;
	assert.equal((await routes.sync()).added, 1);
});

test("dispose() releases every adapter and closes every shim; sync() can rebuild", async () => {
	const accounts = {
		cn: [meta("aaaa1111-0000")],
		ai: [meta("cccc3333-0000", { variantKey: "ai" })]
	};
	const { deps, calls } = makeDeps();
	const { ctx, registrations, events } = makeCtx();
	const routes = new PinnedRoutes({ pool: makePool(accounts), ctx, config: { deps } });
	await routes.sync();

	assert.equal(await routes.dispose(), 2);
	assert.deepEqual(routes.list(), []);
	assert.equal(registrations.every((r) => r.released), true);
	assert.equal(calls.shims.every((shim) => shim.closed), true);
	assert.equal(events.at(-1), "llm/adapters-updated");

	// Idempotent, and reusable.
	assert.equal(await routes.dispose(), 0);
	await routes.sync();
	assert.equal(routes.list().length, 2);
	assert.equal(registrations.length, 4);
});

test("PinnedRoutes without a pool refuses to be constructed", () => {
	assert.throws(() => new PinnedRoutes({ ctx: makeCtx().ctx }), (error) => {
		assert.equal(error.code, "missing-pool");
		return true;
	});
});

/* ------------------------------------------------------------- config knobs */

test("config.providerPrefix and ownPathFor are honoured", async () => {
	const accounts = { cn: [meta("aaaa1111-0000")], ai: [] };
	const { deps, calls } = makeDeps();
	const { ctx, registrations } = makeCtx();
	const seen = [];
	const routes = new PinnedRoutes({
		pool: makePool(accounts),
		ctx,
		config: {
			deps,
			providerPrefix: "wbm.",
			ownPathFor: (providerId, variantKey, uid) => {
				seen.push([providerId, variantKey, uid]);
				return `/tmp/own/${providerId}.auth.json`;
			}
		}
	});

	await routes.sync();

	assert.deepEqual(registrations.map((r) => r.ids[0]), ["wbm.aaaa1111"]);
	assert.deepEqual(seen, [["wbm.aaaa1111", "cn", "aaaa1111-0000"]]);
	assert.equal(calls.stores[0].ownPath, "/tmp/own/wbm.aaaa1111.auth.json");
});
