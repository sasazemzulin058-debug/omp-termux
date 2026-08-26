import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AnimationFrame, TranscriptPresentationTarget } from "../../modes/components/transcript-container";
import { fgOrPlain } from "../../modes/theme/theme";
import { QrCode, renderQrHalfBlocks } from "../../utils/qrcode";

/**
 * One-shot transcript block that prints a collab browser-join URL as a
 * scannable QR code. The symbol is encoded once at construction (byte mode,
 * EC level M) and rendered as ANSI half-blocks; on terminals too narrow for
 * the symbol it degrades to a one-line hint pointing at the printed URL.
 *
 * The transcript viewport can also clip a live block to a single row under
 * pressure (many short settled blocks — typical when thinking is a one-line
 * summary rather than a tall trace). The QR's first/last rows are a white
 * quiet zone, so a 1-row clip looks like an empty white line. When the
 * allocated height cannot fit the full symbol, degrade to the same hint.
 */
export class CollabQrCodeComponent implements Component, TranscriptPresentationTarget {
	readonly #lines: readonly string[];
	readonly #minWidth: number;
	#allocatedRows = Number.POSITIVE_INFINITY;

	constructor(readonly url: string) {
		const rows = renderQrHalfBlocks(QrCode.encodeText(url, "M"));
		this.#lines = rows.map(row => ` ${row}`);
		this.#minWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row)), 0) + 1;
	}

	setTranscriptAllocation(rows: number, _frame?: AnimationFrame): void {
		this.#allocatedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : Number.POSITIVE_INFINITY;
	}

	render(width: number): readonly string[] {
		if (width < this.#minWidth) {
			return [this.#hiddenHint(`terminal width ${width}; need ${this.#minWidth}`)];
		}
		if (this.#allocatedRows < this.#lines.length) {
			return [this.#hiddenHint(`viewport height ${this.#allocatedRows}; need ${this.#lines.length}`)];
		}
		return this.#lines;
	}

	#hiddenHint(reason: string): string {
		return ` ${fgOrPlain("warning", `QR code hidden: ${reason}. Use the browser URL above.`)}`;
	}
}
