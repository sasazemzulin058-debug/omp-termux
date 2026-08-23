import type { Component, HistoryBatch } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";
import { isToolActivityComponent } from "./tool-activity";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport, re-rendering at
 *   the current width every frame (so resizes reflow it) until capacity
 *   pressure retires it.
 * - `committed`: appended to terminal history; immutable and never re-rendered.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
}

const MAX_LIVE_BLOCKS = 256;
const EMPTY_ROWS: readonly string[] = [];

function isFinalized(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.isTranscriptBlockFinalized?.() ?? true;
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: { batch: HistoryBatch; end: number } | undefined;
	#toolActivityVisible = true;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };

	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#entries.push({ component, state: "active" });
	}

	override removeChild(component: Component): void {
		if (this.children.indexOf(component) < 0) return;
		if (!this.canRemoveBlock(component)) return;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
	}

	override clear(): void {
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		// Active and settled blocks only live in the mutable viewport, so removing
		// them leaves no trace. Committed blocks are immutable terminal history,
		// and blocks inside the offered-but-unacknowledged batch are mid-write —
		// removing one would desync the offer's entry range.
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		if (this.#entries[index]!.state === "committed") return false;
		return this.#offered === undefined || index >= this.#offered.end;
	}
	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Rebuild retirement state before replaying the complete transcript history. */
	resetRetirement(): void {
		this.#frontier = 0;
		this.#offered = undefined;
		for (const entry of this.#entries) {
			if (entry.state === "committed") entry.state = isFinalized(entry.component) ? "settled" : "active";
		}
	}

	/** Total rows the live (non-committed, non-offered) tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const rendered of this.#liveBlocks(width)) {
			if (rendered.length > 0) total += rendered.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Render the live tail, constrained to the supplied transcript height. */
	renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) return EMPTY_ROWS;
		if (live.length > capacity) return this.#renderEmergency(live, width, capacity, frame);

		// Full-height pass first: within capacity, live blocks render whole.
		const blocks: (readonly string[])[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			this.#setAllocation(live[index]!.component, Number.MAX_SAFE_INTEGER, frame);
			const rendered = trimBlankEdges(live[index]!.component.render(width));
			blocks[index] = rendered;
			if (rendered.length > 0) total += rendered.length + (visible++ > 0 ? 1 : 0);
		}
		if (total <= capacity) {
			const output: string[] = [];
			for (const rendered of blocks) {
				if (rendered.length === 0) continue;
				if (output.length > 0) output.push("");
				output.push(...rendered);
			}
			return output;
		}

		// Pressure: one row minimum per block, surplus to the newest blocks first,
		// separators dropped. Tool blocks re-render compact below three rows; text
		// blocks keep their latest rows visible.
		const allocation: number[] = new Array(live.length).fill(1);
		let surplus = capacity - live.length;
		for (let index = live.length - 1; index >= 0 && surplus > 0; index--) {
			const extra = Math.min(Math.max(0, blocks[index]!.length - 1), surplus);
			allocation[index] += extra;
			surplus -= extra;
		}
		const output: string[] = [];
		for (let index = 0; index < live.length; index++) {
			const allocated = allocation[index]!;
			this.#setAllocation(live[index]!.component, allocated, frame);
			const rendered = trimBlankEdges(live[index]!.component.render(width));
			if (rendered.length <= allocated) output.push(...rendered);
			else output.push(...rendered.slice(rendered.length - allocated));
		}
		return output.length > capacity ? output.slice(output.length - capacity) : output;
	}

	/**
	 * Offer the settled prefix that must retire for the live tail to fit
	 * `capacity` rows. Blocks stay live (re-rendering at the current width)
	 * while room remains; the offer stands until the terminal acknowledges it.
	 */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			this.#setAllocation(live[index]!.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = trimBlankEdges(live[index]!.component.render(width));
			heights[index] = rendered.length;
			if (rendered.length > 0) total += rendered.length + (visible++ > 0 ? 1 : 0);
		}
		const overflowing = total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (!overflowing) return undefined;
		// Retire the longest settled prefix needed to fit; commit order is
		// absolute, so retirement stops at the first still-active block.
		let end = this.#frontier;
		let freed = 0;
		let index = 0;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			if (total - freed <= room && this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS) break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.#frontier) return undefined;
		const rows: string[] = [];
		for (let retire = this.#frontier; retire < end; retire++) {
			this.#setAllocation(this.#entries[retire]!.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(this.#entries[retire]!.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		if (rows.length > 0) rows.push("");
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows };
		this.#offered = { batch, end };
		return batch;
	}

	/** Retire exactly the history batch most recently offered by this container. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		for (let index = this.#frontier; index < offered.end; index++) {
			this.#entries[index]!.state = "committed";
		}
		this.#frontier = offered.end;
		this.#offered = undefined;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		const rows: string[] = [];
		for (const entry of this.#entries) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		return rows;
	}

	#renderEmergency(
		live: readonly TranscriptEntry[],
		width: number,
		rows: number,
		frame: AnimationFrame,
	): readonly string[] {
		const output: string[] = [];
		const hiddenCount = Math.max(0, live.length - rows);
		let hiddenActive = 0;
		for (let index = 0; index < hiddenCount; index++) {
			if (live[index]!.state === "active") hiddenActive++;
		}
		if (hiddenActive > 0) output.push(`${hiddenActive} more transcript blocks active`);
		const visibleRows = rows - output.length;
		const visible = visibleRows > 0 ? live.slice(-visibleRows) : [];
		for (const entry of visible) {
			this.#setAllocation(entry.component, 1, frame);
			output.push(entry.component.render(width)[0] ?? "");
		}
		return output.slice(0, rows);
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	#settleFinalized(): void {
		for (const entry of this.#entries) {
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	/** Live entries: past the committed frontier and not in the offered batch. */
	#liveEntries(): TranscriptEntry[] {
		const start = this.#offered?.end ?? this.#frontier;
		return this.#entries.slice(start);
	}

	*#liveBlocks(width: number): Generator<readonly string[]> {
		for (const entry of this.#liveEntries()) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			yield trimBlankEdges(entry.component.render(width));
		}
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(component => existing.get(component) ?? { component, state: "active" });
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one semantic transcript block. */
export class TranscriptBlock extends Container {}
