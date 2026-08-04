/**
 * @license
 * Copyright 2017 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { CDPSessionEvent } from '../api/CDPSession.js';
import { FrameEvent } from '../api/Frame.js';
import { EventEmitter } from '../common/EventEmitter.js';
import { debugError, PuppeteerURL, UTILITY_WORLD_NAME } from '../common/util.js';
import { assert } from '../util/assert.js';
import { Deferred } from '../util/Deferred.js';
import { disposeSymbol } from '../util/disposable.js';
import { isErrorLike } from '../util/ErrorLike.js';
import { CdpIssue } from './CdpIssue.js';
import { CdpPreloadScript } from './CdpPreloadScript.js';
import { CDP_BINDING_PREFIX } from './utils.js';
import { isTargetClosedError } from './Connection.js';
import { CdpDeviceRequestPromptManager } from './DeviceRequestPrompt.js';
import { ExecutionContext } from './ExecutionContext.js';
import { CdpFrame } from './Frame.js';
import { FrameManagerEvent } from './FrameManagerEvents.js';
import { FrameTree } from './FrameTree.js';
import { IsolatedWorld } from './IsolatedWorld.js';
import { MAIN_WORLD, PUPPETEER_WORLD } from './IsolatedWorlds.js';
import { NetworkManager } from './NetworkManager.js';
const TIME_FOR_WAITING_FOR_SWAP = 100; // ms.
const CHROME_EXTENSION_PREFIX = 'chrome-extension://';
/**
 * A frame manager manages the frames for a given {@link Page | page}.
 *
 * @internal
 */
export class FrameManager extends EventEmitter {
    #page;
    #networkManager;
    #timeoutSettings;
    #isolatedWorlds = new Set();
    #client;
    #scriptsToEvaluateOnNewDocument = new Map();
    #bindings = new Set();
    _frameTree = new FrameTree();
    /**
     * Set of frame IDs stored to indicate if a frame has received a
     * frameNavigated event so that frame tree responses could be ignored as the
     * frameNavigated event usually contains the latest information.
     */
    #frameNavigatedReceived = new Set();
    // xxx-stealth: coalesce concurrent world re-acquisitions per frame so the
    // frameNavigated/init/load triggers don't stomp each other's contexts.
    #acquireQueued = new Set();
    #acquirePromises = new Map();
    #deviceRequestPromptManagerMap = new WeakMap();
    #frameTreeHandled;
    get timeoutSettings() {
        return this.#timeoutSettings;
    }
    get networkManager() {
        return this.#networkManager;
    }
    get client() {
        return this.#client;
    }
    constructor(client, page, timeoutSettings) {
        super();
        this.#client = client;
        this.#page = page;
        this.#networkManager = new NetworkManager(this, page.browser().isNetworkEnabled());
        this.#timeoutSettings = timeoutSettings;
        this.setupEventListeners(this.#client);
        client.once(CDPSessionEvent.Disconnected, () => {
            this.#onClientDisconnect().catch(debugError);
        });
    }
    /**
     * Called when the frame's client is disconnected. We don't know if the
     * disconnect means that the frame is removed or if it will be replaced by a
     * new frame. Therefore, we wait for a swap event.
     */
    async #onClientDisconnect() {
        const mainFrame = this._frameTree.getMainFrame();
        if (!mainFrame) {
            return;
        }
        if (!this.#page.browser().connected) {
            // If the browser is not connected we know
            // that activation will not happen
            this.#removeFramesRecursively(mainFrame);
            return;
        }
        for (const child of mainFrame.childFrames()) {
            this.#removeFramesRecursively(child);
        }
        const swapped = Deferred.create({
            timeout: TIME_FOR_WAITING_FOR_SWAP,
            message: 'Frame was not swapped',
        });
        mainFrame.once(FrameEvent.FrameSwappedByActivation, () => {
            swapped.resolve();
        });
        try {
            await swapped.valueOrThrow();
        }
        catch {
            this.#removeFramesRecursively(mainFrame);
        }
    }
    /**
     * When the main frame is replaced by another main frame,
     * we maintain the main frame object identity while updating
     * its frame tree and ID.
     */
    async swapFrameTree(client) {
        this.#client = client;
        const frame = this._frameTree.getMainFrame();
        if (frame) {
            this.#frameNavigatedReceived.add(this.#client.target()._targetId);
            this._frameTree.removeFrame(frame);
            frame.updateId(this.#client.target()._targetId);
            this._frameTree.addFrame(frame);
            frame.updateClient(client);
        }
        this.setupEventListeners(client);
        client.once(CDPSessionEvent.Disconnected, () => {
            this.#onClientDisconnect().catch(debugError);
        });
        await this.initialize(client, frame);
        await this.#networkManager.addClient(client);
        if (frame) {
            frame.emit(FrameEvent.FrameSwappedByActivation, undefined);
        }
    }
    async registerSpeculativeSession(client) {
        await this.#networkManager.addClient(client);
    }
    setupEventListeners(session) {
        session.on('Page.frameAttached', async (event) => {
            await this.#frameTreeHandled?.valueOrThrow();
            this.#onFrameAttached(session, event.frameId, event.parentFrameId);
        });
        session.on('Page.frameNavigated', async (event) => {
            this.#frameNavigatedReceived.add(event.frame.id);
            await this.#frameTreeHandled?.valueOrThrow();
            void this.#onFrameNavigated(event.frame, event.type);
        });
        session.on('Page.navigatedWithinDocument', async (event) => {
            await this.#frameTreeHandled?.valueOrThrow();
            this.#onFrameNavigatedWithinDocument(event.frameId, event.url);
        });
        session.on('Page.frameDetached', async (event) => {
            await this.#frameTreeHandled?.valueOrThrow();
            this.#onFrameDetached(event.frameId, event.reason);
        });
        session.on('Page.frameStartedLoading', async (event) => {
            await this.#frameTreeHandled?.valueOrThrow();
            this.#onFrameStartedLoading(event.frameId);
        });
        session.on('Page.frameStoppedLoading', async (event) => {
            await this.#frameTreeHandled?.valueOrThrow();
            this.#onFrameStoppedLoading(event.frameId);
        });
        session.on('Runtime.executionContextCreated', async (event) => {
            await this.#frameTreeHandled?.valueOrThrow();
            this.#onExecutionContextCreated(event.context, session);
        });
        session.on('Page.lifecycleEvent', async (event) => {
            await this.#frameTreeHandled?.valueOrThrow();
            this.#onLifecycleEvent(event);
        });
        session.on('Audits.issueAdded', event => {
            this.#page.emit("issue" /* PageEvent.Issue */, new CdpIssue(event.issue));
        });
    }
    async initialize(client, frame) {
        try {
            this.#frameTreeHandled?.resolve();
            this.#frameTreeHandled = Deferred.create();
            // We need to schedule all these commands while the target is paused,
            // therefore, it needs to happen synchronously. At the same time we
            // should not start processing execution context and frame events before
            // we received the initial information about the frame tree.
            await Promise.all([
                this.#networkManager.addClient(client),
                client.send('Page.enable'),
                client.send('Page.getFrameTree').then(({ frameTree }) => {
                    this.#handleFrameTree(client, frameTree);
                    this.#frameTreeHandled?.resolve();
                }),
                client.send('Page.setLifecycleEventsEnabled', { enabled: true }),
                // xxx-stealth: do NOT send Runtime.enable. It is the single
                // most-detected automation tell (Brotector/CreepJS/Cloudflare probe
                // it). Execution contexts are instead acquired pull-style in
                // #acquireWorlds (main world via Runtime.evaluate globalThis idOnly,
                // utility world via the Page.createIsolatedWorld response) and fed
                // into the existing push pipeline via #onExecutionContextCreated.
                // The utility-world preload sentinel is kept so world-scoped init
                // scripts still attach on navigation.
                client.send('Page.addScriptToEvaluateOnNewDocument', {
                    source: `//# sourceURL=${PuppeteerURL.INTERNAL_URL}`,
                    worldName: UTILITY_WORLD_NAME,
                }).catch(debugError),
                ...(frame
                    ? Array.from(this.#scriptsToEvaluateOnNewDocument.values())
                    : []).map(script => {
                    return frame?.addPreloadScript(script);
                }),
                ...(frame ? Array.from(this.#bindings.values()) : []).map(binding => {
                    return frame?.addExposedFunctionBinding(binding);
                }),
                this.#page.browser().isIssuesEnabled() && client.send('Audits.enable'),
            ]);
        }
        catch (error) {
            this.#frameTreeHandled?.resolve();
            // The target might have been closed before the initialization finished.
            if (isErrorLike(error) && isTargetClosedError(error)) {
                return;
            }
            throw error;
        }
    }
    page() {
        return this.#page;
    }
    mainFrame() {
        const mainFrame = this._frameTree.getMainFrame();
        assert(mainFrame, 'Requesting main frame too early!');
        return mainFrame;
    }
    frames() {
        return Array.from(this._frameTree.frames());
    }
    frame(frameId) {
        return this._frameTree.getById(frameId) || null;
    }
    async addExposedFunctionBinding(binding) {
        this.#bindings.add(binding);
        await Promise.all(this.frames().map(async (frame) => {
            return await frame.addExposedFunctionBinding(binding);
        }));
    }
    async removeExposedFunctionBinding(binding) {
        this.#bindings.delete(binding);
        await Promise.all(this.frames().map(async (frame) => {
            return await frame.removeExposedFunctionBinding(binding);
        }));
    }
    async evaluateOnNewDocument(source) {
        const { identifier } = await this.mainFrame()
            ._client()
            .send('Page.addScriptToEvaluateOnNewDocument', {
            source,
        });
        const preloadScript = new CdpPreloadScript(this.mainFrame(), identifier, source);
        this.#scriptsToEvaluateOnNewDocument.set(identifier, preloadScript);
        await Promise.all(this.frames().map(async (frame) => {
            return await frame.addPreloadScript(preloadScript);
        }));
        return { identifier };
    }
    async removeScriptToEvaluateOnNewDocument(identifier) {
        const preloadScript = this.#scriptsToEvaluateOnNewDocument.get(identifier);
        if (!preloadScript) {
            throw new Error(`Script to evaluate on new document with id ${identifier} not found`);
        }
        this.#scriptsToEvaluateOnNewDocument.delete(identifier);
        await Promise.all(this.frames().map(frame => {
            const identifier = preloadScript.getIdForFrame(frame);
            if (!identifier) {
                return;
            }
            return frame
                ._client()
                .send('Page.removeScriptToEvaluateOnNewDocument', {
                identifier,
            })
                .catch(debugError);
        }));
    }
    onAttachedToTarget(target) {
        if (target._getTargetInfo().type !== 'iframe') {
            return;
        }
        const frame = this.frame(target._getTargetInfo().targetId);
        if (frame) {
            frame.updateClient(target._session());
        }
        this.setupEventListeners(target._session());
        void this.initialize(target._session(), frame).catch(debugError);
    }
    _deviceRequestPromptManager(client) {
        let manager = this.#deviceRequestPromptManagerMap.get(client);
        if (manager === undefined) {
            manager = new CdpDeviceRequestPromptManager(client, this.#timeoutSettings);
            this.#deviceRequestPromptManagerMap.set(client, manager);
        }
        return manager;
    }
    #onLifecycleEvent(event) {
        const frame = this.frame(event.frameId);
        if (!frame) {
            return;
        }
        frame._onLifecycleEvent(event.loaderId, event.name);
        this.emit(FrameManagerEvent.LifecycleEvent, frame);
        frame.emit(FrameEvent.LifecycleEvent, undefined);
    }
    #onFrameStartedLoading(frameId) {
        const frame = this.frame(frameId);
        if (!frame) {
            return;
        }
        frame._onLoadingStarted();
    }
    #onFrameStoppedLoading(frameId) {
        const frame = this.frame(frameId);
        if (!frame) {
            return;
        }
        frame._onLoadingStopped();
        this.emit(FrameManagerEvent.LifecycleEvent, frame);
        frame.emit(FrameEvent.LifecycleEvent, undefined);
    }
    #handleFrameTree(session, frameTree) {
        if (frameTree.frame.parentId) {
            this.#onFrameAttached(session, frameTree.frame.id, frameTree.frame.parentId);
        }
        if (!this.#frameNavigatedReceived.has(frameTree.frame.id)) {
            void this.#onFrameNavigated(frameTree.frame, 'Navigation');
        }
        else {
            this.#frameNavigatedReceived.delete(frameTree.frame.id);
        }
        if (!frameTree.childFrames) {
            return;
        }
        for (const child of frameTree.childFrames) {
            this.#handleFrameTree(session, child);
        }
    }
    #onFrameAttached(session, frameId, parentFrameId) {
        let frame = this.frame(frameId);
        if (frame) {
            const parentFrame = this.frame(parentFrameId);
            if (session && parentFrame && frame.client !== parentFrame?.client) {
                // If an OOP iframes becomes a normal iframe
                // again it is first attached to the parent frame before the
                // target is removed.
                frame.updateClient(session);
            }
            return;
        }
        frame = new CdpFrame(this, frameId, parentFrameId, session);
        this.#installContextProviders(frame);
        this._frameTree.addFrame(frame);
        this.emit(FrameManagerEvent.FrameAttached, frame);
    }
    async #onFrameNavigated(framePayload, navigationType) {
        const frameId = framePayload.id;
        const isMainFrame = !framePayload.parentId;
        let frame = this._frameTree.getById(frameId);
        // Detach all child frames first.
        if (frame) {
            for (const child of frame.childFrames()) {
                this.#removeFramesRecursively(child);
            }
        }
        // Update or create main frame.
        if (isMainFrame) {
            if (frame) {
                // Update frame id to retain frame identity on cross-process navigation.
                this._frameTree.removeFrame(frame);
                frame._id = frameId;
            }
            else {
                // Initial main frame navigation.
                frame = new CdpFrame(this, frameId, undefined, this.#client);
            }
            this._frameTree.addFrame(frame);
        }
        frame = await this._frameTree.waitForFrame(frameId);
        frame._navigated(framePayload);
        this.emit(FrameManagerEvent.FrameNavigated, frame);
        frame.emit(FrameEvent.FrameNavigated, navigationType);
        // xxx-stealth: install lazy context providers and invalidate the
        // pre-navigation contexts. With Runtime.enable off there is no
        // executionContextDestroyed event, so dispose synchronously here; this makes
        // IsolatedWorld.#context undefined so the next evaluate pulls a fresh context
        // via its provider (resolved after the navigation has settled) instead of
        // using a dead one. We intentionally do NOT proactively acquire — proactive
        // contexts captured mid-navigation go stale silently. Resolution is lazy.
        this.#installContextProviders(frame);
        for (const world of this.#frameWorlds(frame)) {
            world?.context?.[disposeSymbol]();
        }
    }
    // xxx-stealth: the main + utility worlds. worlds is keyed by Symbols, so
    // Object.values misses them — enumerate the known world symbols explicitly.
    #frameWorlds(frame) {
        return [frame.worlds[MAIN_WORLD], frame.worlds[PUPPETEER_WORLD]];
    }
    // xxx-stealth: point each of the frame's worlds at the coalesced acquirer
    // so IsolatedWorld can pull its context on demand.
    #installContextProviders(frame) {
        for (const world of this.#frameWorlds(frame)) {
            world?.setContextProvider?.(() => this.#acquireWorlds(frame));
        }
    }
    // xxx-stealth: coalescing acquirer. Returns a promise that resolves when
    // the current (or freshly started) acquisition for this frame completes, so a
    // lazy provider can await it. Concurrent callers share the in-flight promise
    // rather than racing — concurrent acquires resolve different transient contexts
    // and blank each other.
    #acquireWorlds(frame) {
        const id = frame._id;
        const existing = this.#acquirePromises.get(id);
        if (existing) {
            this.#acquireQueued.add(id);
            return existing;
        }
        const promise = this.#doAcquireWorlds(frame).finally(() => {
            this.#acquirePromises.delete(id);
            if (this.#acquireQueued.delete(id) && this.frame(id)) {
                void this.#acquireWorlds(frame);
            }
        });
        this.#acquirePromises.set(id, promise);
        return promise;
    }
    // xxx-stealth: true when `frame` is the top frame of its CDP session
    // (the page main frame, or an OOP iframe root). Only such frames can resolve
    // their main world via a context-less Runtime.evaluate, because that targets
    // the session's default context. Same-process sub-frames share the parent's
    // session, so a context-less evaluate would resolve the WRONG frame — we skip
    // proactive main-world acquisition for them rather than mis-register.
    #frameIsTopOfSession(frame) {
        const parentId = frame._parentId;
        if (!parentId) {
            return true;
        }
        const parent = this.frame(parentId);
        return !parent || parent.client !== frame.client;
    }
    // xxx-stealth: pull-acquire a frame's main + utility execution contexts
    // without Runtime.enable, then feed them into the normal push pipeline.
    async #doAcquireWorlds(frame) {
        const session = frame.client;
        // xxx-stealth: never pre-dispose here. IsolatedWorld.setContext
        // already disposes the previous context when a fresh one is installed, and
        // a transiently-failed resolve (common while a navigation is mid-flight)
        // must leave the last good context intact rather than blank the world.
        // Stale invalidation on navigation is handled once in #onFrameNavigated.
        try {
            // Utility (PUPPETEER) world: Page.createIsolatedWorld returns the new
            // context id directly — works for any frameId on the session.
            const iso = await session
                .send('Page.createIsolatedWorld', {
                frameId: frame._id,
                worldName: UTILITY_WORLD_NAME,
                grantUniveralAccess: true,
            })
                .catch(debugError);
            const utilityId = iso && typeof iso.executionContextId === 'number' ? iso.executionContextId : undefined;
            if (utilityId !== undefined) {
                this.#onExecutionContextCreated({
                    id: utilityId,
                    name: UTILITY_WORLD_NAME,
                    origin: '',
                    auxData: { frameId: frame._id, isDefault: false },
                }, session);
            }
            // Main world: resolve this frame's main execution context id.
            const id = await this.#resolveMainContextId(session, frame, utilityId);
            if (id !== undefined) {
                this.#onExecutionContextCreated({
                    id,
                    name: '',
                    origin: '',
                    auxData: { frameId: frame._id, isDefault: true },
                }, session);
                // xxx-stealth: re-install exposed-function bindings into the
                // freshly acquired main world. Normally the binding wrapper is
                // (re)installed when Chrome fires executionContextCreated; with that
                // event silenced we must re-add the native binding for this context
                // id and re-run the wrapper init source ourselves on every navigation.
                for (const binding of this.#bindings) {
                    void session
                        .send('Runtime.addBinding', {
                        name: CDP_BINDING_PREFIX + binding.name,
                        executionContextId: id,
                    })
                        .catch(() => { });
                    void session
                        .send('Runtime.evaluate', {
                        expression: binding.initSource,
                        contextId: id,
                    })
                        .catch(() => { });
                }
            }
        }
        catch (error) {
            debugError(error);
        }
    }
    // xxx-stealth: resolve a frame's MAIN-world execution context id without
    // Runtime.enable. For the top frame of a session a context-less
    // `Runtime.evaluate globalThis` resolves the session default (cheap, 1 RTT). For
    // same-process sub-frames that would resolve the PARENT, so instead we take the
    // frame's document node (via the utility world we just created) and DOM.resolveNode
    // it with no executionContextId — CDP resolves it in the owning frame's main world,
    // whose objectId encodes the main context id. The objectId format is
    // `<backend>.<contextId>.<n>`.
    async #resolveMainContextId(session, frame, utilityId) {
        const parse = (objectId) => {
            if (typeof objectId !== 'string') {
                return undefined;
            }
            const id = Number.parseInt(objectId.split('.')[1] ?? '', 10);
            return Number.isNaN(id) ? undefined : id;
        };
        if (this.#frameIsTopOfSession(frame)) {
            const globalThis = await session
                .send('Runtime.evaluate', {
                expression: 'globalThis',
                serializationOptions: { serialization: 'idOnly' },
            })
                .catch(debugError);
            return parse(globalThis?.result?.objectId);
        }
        if (utilityId === undefined) {
            return undefined;
        }
        const utilDoc = await session
            .send('Runtime.evaluate', {
            expression: 'document',
            contextId: utilityId,
            serializationOptions: { serialization: 'idOnly' },
        })
            .catch(debugError);
        const utilDocObjectId = utilDoc?.result?.objectId;
        if (typeof utilDocObjectId !== 'string') {
            return undefined;
        }
        const described = await session
            .send('DOM.describeNode', { objectId: utilDocObjectId })
            .catch(debugError);
        const backendNodeId = described?.node?.backendNodeId;
        if (typeof backendNodeId !== 'number') {
            return undefined;
        }
        const mainNode = await session
            .send('DOM.resolveNode', { backendNodeId })
            .catch(debugError);
        return parse(mainNode?.object?.objectId);
    }
    async #createIsolatedWorld(session, name) {
        const key = `${session.id()}:${name}`;
        if (this.#isolatedWorlds.has(key)) {
            return;
        }
        await session.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `//# sourceURL=${PuppeteerURL.INTERNAL_URL}`,
            worldName: name,
        });
        await Promise.all(this.frames()
            .filter(frame => {
            return frame.client === session;
        })
            .map(frame => {
            // Frames might be removed before we send this, so we don't want to
            // throw an error.
            return session
                .send('Page.createIsolatedWorld', {
                frameId: frame._id,
                worldName: name,
                grantUniveralAccess: true,
            })
                .catch(debugError);
        }));
        this.#isolatedWorlds.add(key);
    }
    #onFrameNavigatedWithinDocument(frameId, url) {
        const frame = this.frame(frameId);
        if (!frame) {
            return;
        }
        frame._navigatedWithinDocument(url);
        this.emit(FrameManagerEvent.FrameNavigatedWithinDocument, frame);
        frame.emit(FrameEvent.FrameNavigatedWithinDocument, undefined);
        this.emit(FrameManagerEvent.FrameNavigated, frame);
        frame.emit(FrameEvent.FrameNavigated, 'Navigation');
    }
    #onFrameDetached(frameId, reason) {
        const frame = this.frame(frameId);
        if (!frame) {
            return;
        }
        switch (reason) {
            case 'remove':
                // Only remove the frame if the reason for the detached event is
                // an actual removement of the frame.
                // For frames that become OOP iframes, the reason would be 'swap'.
                this.#removeFramesRecursively(frame);
                break;
            case 'swap':
                this.emit(FrameManagerEvent.FrameSwapped, frame);
                frame.emit(FrameEvent.FrameSwapped, undefined);
                break;
        }
    }
    #isExtensionOrigin(origin) {
        return origin.startsWith(CHROME_EXTENSION_PREFIX);
    }
    #extractExtensionId(origin) {
        if (!origin || !this.#isExtensionOrigin(origin)) {
            return null;
        }
        const pathPart = origin.substring(CHROME_EXTENSION_PREFIX.length);
        const slashIndex = pathPart.indexOf('/');
        // if there's no / it means that pathPart is now the extensionId, otherwise
        // we take everything until the first /
        return slashIndex === -1 ? pathPart : pathPart.substring(0, slashIndex);
    }
    #onExecutionContextCreated(contextPayload, session) {
        const auxData = contextPayload.auxData;
        const origin = contextPayload.origin;
        const frameId = auxData && auxData.frameId;
        const frame = typeof frameId === 'string' ? this.frame(frameId) : undefined;
        let world;
        if (frame) {
            // Only care about execution contexts created for the current session.
            if (frame.client !== session) {
                return;
            }
            if (contextPayload.auxData && contextPayload.auxData['isDefault']) {
                world = frame.worlds[MAIN_WORLD];
            }
            else if (contextPayload.name === UTILITY_WORLD_NAME) {
                // In case of multiple sessions to the same target, there's a race between
                // connections so we might end up creating multiple isolated worlds.
                // We can use either.
                world = frame.worlds[PUPPETEER_WORLD];
            }
            else if (this.#isExtensionOrigin(origin)) {
                const extId = this.#extractExtensionId(origin);
                if (!extId) {
                    debugError('Error while parsing extension id');
                    return;
                }
                if (frame.extensionWorlds[extId]) {
                    world = frame.extensionWorlds[extId];
                }
                else {
                    world = new IsolatedWorld(frame, this.timeoutSettings, extId);
                    frame.extensionWorlds[extId] = world;
                    frame.registerWorldListeners(world);
                    world.origin = origin;
                    world.setWorldId(extId);
                }
            }
        }
        // If there is no world, the context is not meant to be handled by us.
        if (!world) {
            return;
        }
        const context = new ExecutionContext(frame?.client || this.#client, contextPayload, world);
        world.setContext(context);
    }
    #removeFramesRecursively(frame) {
        for (const child of frame.childFrames()) {
            this.#removeFramesRecursively(child);
        }
        this._frameTree.removeFrame(frame);
        this.emit(FrameManagerEvent.FrameDetached, frame);
        frame.emit(FrameEvent.FrameDetached, frame);
        // Needs to be last to ensure events
        // sent before handlers are cleared.
        frame[disposeSymbol]();
    }
}
//# sourceMappingURL=FrameManager.js.map