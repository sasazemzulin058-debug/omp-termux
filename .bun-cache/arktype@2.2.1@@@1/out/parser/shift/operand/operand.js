import { whitespaceChars } from "@ark/util";
import { enclosingChar, enclosingQuote, parseEnclosed } from "./enclosed.js";
import { parseUnenclosed, writeMissingOperandMessage } from "./unenclosed.js";
export const parseOperand = (s) => s.scanner.lookahead === "" ? s.error(writeMissingOperandMessage(s))
    : s.scanner.lookahead === "(" ? s.shiftedBy(1).reduceGroupOpen()
        : s.scanner.lookaheadIsIn(enclosingChar) ? parseEnclosed(s, s.scanner.shift())
            : s.scanner.lookaheadIsIn(whitespaceChars) ? parseOperand(s.shiftedBy(1))
                : s.scanner.lookahead === "d" ?
                    s.scanner.nextLookahead in enclosingQuote ?
                        parseEnclosed(s, `${s.scanner.shift()}${s.scanner.shift()}`)
                        : parseUnenclosed(s)
                    : s.scanner.lookahead === "x" ?
                        s.scanner.nextLookahead === "/" ?
                            s.shiftedBy(2) && parseEnclosed(s, "x/")
                            : parseUnenclosed(s)
                        : parseUnenclosed(s);
