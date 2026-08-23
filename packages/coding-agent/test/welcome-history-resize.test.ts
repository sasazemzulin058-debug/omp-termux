import { beforeAll, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component, RenderScheduler } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class ResizeScheduler implements RenderScheduler {
	#now = 0;
	#pending = new Set<() => void>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
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
	advance(ms: number): void {
		this.#now += ms;
	}
}

class MutableComposerTail implements Component {
	status = "thinking low";

	invalidate(): void {}

	render(): readonly string[] {
		return ["╭─ EDITOR TOP ─╮", `│ ${this.status} │`, "╰─ EDITOR BOTTOM ─╯"];
	}
}
class WidthTranscriptBlock implements Component {
	constructor(readonly id: number) {}

	render(width: number): readonly string[] {
		return [`block-${this.id}@${width}`];
	}
}

class TrackingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

function plainBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

function rowOf(rows: readonly string[], needle: string): number {
	return rows.findIndex(row => row.includes(needle));
}

function countRows(rows: readonly string[], needle: string): number {
	return rows.filter(row => row.includes(needle)).length;
}

function expectOneExactEditor(rows: readonly string[], status: string): number {
	const top = rowOf(rows, "EDITOR TOP");
	expect(countRows(rows, "EDITOR TOP")).toBe(1);
	expect(countRows(rows, status)).toBe(1);
	expect(countRows(rows, "EDITOR BOTTOM")).toBe(1);
	expect(rowOf(rows, status)).toBe(top + 1);
	expect(rowOf(rows, "EDITOR BOTTOM")).toBe(top + 2);
	return top;
}

beforeAll(async () => {
	await initTheme();
});

describe("composer welcome native-history resize", () => {
	it("keeps one exact editor rectangle and retired welcome through repeated thinking and resize frames", async () => {
		const terminal = new TrackingTerminal(80, 12);
		const scheduler = new ResizeScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false, resizeScrollback: "preserve" },
			welcome: { version: "test", modelName: "test-model", providerName: "test-provider" },
		});
		const offered: number[] = [];
		const acknowledged: number[] = [];
		let resizeFrames = 0;
		const renderFrame = composer.renderFrame.bind(composer);
		const renderResizeFrame = composer.renderResizeFrame.bind(composer);
		const acknowledgeHistory = composer.acknowledgeHistory.bind(composer);
		composer.renderFrame = viewport => {
			const plan = renderFrame(viewport);
			if (plan.history) offered.push(plan.history.id);
			return plan;
		};
		composer.renderResizeFrame = viewport => {
			resizeFrames++;
			return renderResizeFrame(viewport);
		};
		composer.acknowledgeHistory = id => {
			acknowledged.push(id);
			acknowledgeHistory(id);
		};

		const transcript = new TranscriptContainer();
		const tail = new MutableComposerTail();
		composer.setRuntimeChildren([transcript, tail]);
		composer.start({ playWelcomeIntro: false });

		expect(countRows(plainBuffer(terminal), "Welcome back!")).toBe(1);
		expect(offered).toHaveLength(1);
		expect(acknowledged).toEqual(offered);
		const initialAnchor = expectOneExactEditor(
			terminal.getViewport().map(row => Bun.stripANSI(row)),
			tail.status,
		);
		expect(initialAnchor).toBe(9);
		const writesAfterRetirement = terminal.writes.length;

		for (let index = 0; index < 40; index++) {
			tail.status = index % 2 === 0 ? "thinking high" : "thinking low";
			composer.ui.requestRender(true);
			const viewport = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(expectOneExactEditor(viewport, tail.status)).toBe(initialAnchor);
			expect(countRows(plainBuffer(terminal), "Welcome back!")).toBe(1);
		}
		expect(offered).toHaveLength(1);
		expect(acknowledged).toHaveLength(1);

		let lastTransient: string[] = [];
		for (const [columns, rows] of [
			[96, 28],
			[104, 30],
			[100, 34],
		] as const) {
			terminal.resize(columns, rows);
			lastTransient = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(countRows(lastTransient, "Welcome back!")).toBe(1);
			expectOneExactEditor(lastTransient, tail.status);
		}
		expect(resizeFrames).toBe(3);
		scheduler.settle();
		// The settled anchor repaint waits on the CPR reply, which VirtualTerminal
		// delivers on a microtask — drain it before reading the normal screen.
		await terminal.flush();

		let settledViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(settledViewport, "Welcome back!")).toBe(1);
		expect(rowOf(settledViewport, "Welcome back!")).toBe(rowOf(lastTransient, "Welcome back!"));
		expect(expectOneExactEditor(settledViewport, tail.status)).toBe(expectOneExactEditor(lastTransient, tail.status));
		expect(countRows(plainBuffer(terminal), "EDITOR TOP")).toBe(1);
		scheduler.advance(101);

		for (const [columns, rows] of [
			[92, 30],
			[72, 50],
		] as const) {
			terminal.resize(columns, rows);
			lastTransient = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(countRows(lastTransient, "Welcome back!")).toBe(1);
			expectOneExactEditor(lastTransient, tail.status);
		}
		expect(resizeFrames).toBe(5);
		scheduler.settle();
		await terminal.flush();

		settledViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(settledViewport, "Welcome back!")).toBe(1);
		expect(expectOneExactEditor(settledViewport, tail.status)).toBeGreaterThan(
			rowOf(settledViewport, "Welcome back!"),
		);
		expect(countRows(plainBuffer(terminal), "EDITOR TOP")).toBe(1);
		expect(offered).toHaveLength(1);
		expect(acknowledged).toHaveLength(1);
		expect(terminal.writes.slice(writesAfterRetirement).some(write => write.includes("\x1b[3J"))).toBe(false);
		composer.ui.stop();
	});
	it("rebuilds retired transcript rows at the settled width by default", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		for (let id = 0; id < 4; id++) transcript.addChild(new WidthTranscriptBlock(id));
		composer.setRuntimeChildren([transcript, new MutableComposerTail()]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);

		expect(plainBuffer(terminal)).toContain("block-0@20");

		terminal.resize(30, 4);
		await scheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(resized.some(row => row.includes("@20"))).toBe(false);
		expect(resized).toContain("block-0@30");
		expect(resized).toContain("block-3@30");
		composer.ui.stop();
	});
});
