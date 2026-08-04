import { BaseConstraint } from "./constraint.js";
import { compileObjectLiteral, implementNode } from "./shared/implement.js";
import { registeredReference } from "./shared/registry.js";
const implementation = implementNode({
    kind: "predicate",
    hasAssociatedError: true,
    collapsibleKey: "predicate",
    keys: {
        predicate: {}
    },
    normalize: schema => typeof schema === "function" ? { predicate: schema } : schema,
    defaults: {
        description: node => `valid according to ${node.predicate.name || "an anonymous predicate"}`
    },
    intersectionIsOpen: true,
    intersections: {
        // as long as the narrows in l and r are individually safe to check
        // in the order they're specified, checking them in the order
        // resulting from this intersection should also be safe.
        predicate: () => null
    }
});
export class PredicateNode extends BaseConstraint {
    serializedPredicate = registeredReference(this.predicate);
    compiledCondition = `${this.serializedPredicate}(data, ctx)`;
    compiledNegation = `!${this.compiledCondition}`;
    impliedBasis = null;
    expression = this.serializedPredicate;
    traverseAllows = this.predicate;
    errorContext = {
        code: "predicate",
        description: this.description,
        meta: this.meta
    };
    compiledErrorContext = compileObjectLiteral(this.errorContext);
    traverseApply = (data, ctx) => {
        const errorCount = ctx.currentErrorCount;
        if (!this.predicate(data, ctx.external) &&
            ctx.currentErrorCount === errorCount)
            ctx.errorFromNodeContext(this.errorContext);
    };
    compile(js) {
        if (js.traversalKind === "Allows") {
            js.return(this.compiledCondition);
            return;
        }
        js.initializeErrorCount();
        js.if(
        // only add the default error if the predicate didn't add one itself
        `${this.compiledNegation} && ctx.currentErrorCount === errorCount`, () => js.line(`ctx.errorFromNodeContext(${this.compiledErrorContext})`));
    }
    reduceJsonSchema(base, ctx) {
        return ctx.fallback.predicate({
            code: "predicate",
            base,
            predicate: this.predicate
        });
    }
}
export const Predicate = {
    implementation,
    Node: PredicateNode
};
