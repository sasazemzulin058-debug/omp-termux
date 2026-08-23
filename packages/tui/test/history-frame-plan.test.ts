import { describe, expect, it } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class Provider implements TerminalFrameProvider {
	plan: TerminalFramePlan;
	resizeRows: readonly string[] | undefined;
	acknowledged: number[] = [];

	constructor(plan: TerminalFramePlan) {
		this.plan = plan;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return this.plan;
	}
	renderResizeFrame(_viewport: ViewportSize): readonly string[] {
		return this.resizeRows ?? this.plan.viewport;
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
		this.plan = { viewport: this.plan.viewport };
	}
}

const scheduler = {
	now: () => 0,
	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	},
	scheduleRender(callback: () => void) {
		callback();
		return { cancel() {} };
	},
};
class ResizeScheduler {
	#now = 0;
	#pending = new Set<() => void>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		callback();
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}

	settle(): void {
		this.#now += 120;
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
}
class WidthReplayProvider implements TerminalFrameProvider {
	#nextHistoryId = 1;
	#retired = false;
	resetCount = 0;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const width = viewport.columns;
		return {
			history: this.#retired
				? undefined
				: { id: this.#nextHistoryId, rows: [`history-one@${width}`, `history-two@${width}`] },
			viewport: [`editor@${width}`],
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextHistoryId) return;
		this.#nextHistoryId++;
		this.#retired = true;
	}

	resetHistory(): void {
		this.#retired = false;
		this.resetCount++;
	}
}

class HeightReplayProvider implements TerminalFrameProvider {
	#nextHistoryId = 1;
	#retired = false;
	resetCount = 0;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		return {
			history: this.#retired
				? undefined
				: { id: this.#nextHistoryId, rows: ["real-todo-block", "real-read-block", "real-bash-block"] },
			viewport: ["dot-live-one", "dot-live-two", "editor"].slice(-viewport.rows),
		};
	}

	renderResizeFrame(): readonly string[] {
		return ["resize frame"];
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextHistoryId) return;
		this.#nextHistoryId++;
		this.#retired = true;
	}

	resetHistory(): void {
		this.#retired = false;
		this.resetCount++;
	}
}

function plainBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

describe("terminal frame plans", () => {
	it("appends finalized history once and leaves the requested mutable viewport intact", () => {
		const terminal = new VirtualTerminal(20, 3);
		const provider = new Provider({
			history: { id: 1, rows: ["history one", "history two"] },
			viewport: ["editor", "status"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		expect(provider.acknowledged).toEqual([1]);
		expect(terminal.getBufferPosition().baseY).toBe(1);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["history two", "editor", "status"]);
		tui.stop();
	});
	it("repaints a viewport-only frame in place without scrolling", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({ viewport: ["spinner one", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = { viewport: ["spinner two", "editor"] };
		tui.requestRender(true);
		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["spinner two", "editor", "", ""]);
		tui.stop();
	});

	it("keeps visible history above the anchored viewport while room remains", () => {
		const terminal = new VirtualTerminal(20, 6);
		const provider = new Provider({ history: { id: 1, rows: ["block one"] }, viewport: ["editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = { history: { id: 2, rows: ["block two"] }, viewport: ["editor"] };
		tui.requestRender(true);
		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"block one",
			"block two",
			"editor",
			"",
			"",
			"",
		]);
		tui.stop();
	});

	it("uses the alternate buffer during resize and restores anchored history", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({ history: { id: 1, rows: ["welcome"] }, viewport: ["editor"] });
		provider.resizeRows = ["welcome", "editor"];
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.start();

		terminal.resize(24, 5);
		expect(
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.slice(0, 2),
		).toEqual(["welcome", "editor"]);

		renderScheduler.settle();
		renderScheduler.settle();
		expect(
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.slice(0, 2),
		).toEqual(["welcome", "editor"]);
		tui.stop();
	});
	it("keeps live viewport rows out of scrollback during a height shrink", () => {
		// Committed history above a pressured live tail (compact placeholder
		// rows). The terminal can push a placeholder before the resize callback runs,
		// so rebuild the semantic history after every geometry change: only real
		// finalized blocks become permanent scrollback bytes.
		const terminal = new VirtualTerminal(20, 6);
		const provider = new HeightReplayProvider();
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.setResizeScrollback("rebuild");
		tui.start();
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"real-todo-block",
			"real-read-block",
			"real-bash-block",
			"dot-live-one",
			"dot-live-two",
			"editor",
		]);

		terminal.resize(20, 2); // a single large shrink can push live rows before the callback runs
		renderScheduler.settle(); // restore the normal buffer, start the anchor probe
		renderScheduler.settle(); // probe timeout → settled repaint

		const scrollback = plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY);
		expect(scrollback.some(row => row.includes("dot-live"))).toBe(false);
		expect(scrollback).toEqual(["real-todo-block", "real-read-block", "real-bash-block"]);
		expect(provider.resetCount).toBe(1);
		tui.stop();
	});

	it("appends a current-width replay after settled resize", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("append");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		expect(plainBuffer(terminal)).toContain("history-one@20");

		terminal.resize(30, 2);
		await renderScheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(1);
		expect(resized).toContain("history-one@20");
		expect(resized).toContain("history-one@30");
		expect(resized.slice(-2)).toEqual(["history-two@30", "editor@30"]);
		tui.stop();
	});

	it("rebuilds current-width history without retaining stale rows", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		terminal.resize(30, 2);
		await renderScheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(1);
		expect(resized.some(row => row.includes("@20"))).toBe(false);
		expect(resized).toEqual(["history-one@30", "history-two@30", "editor@30"]);
		tui.stop();
	});
});
