"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_NODES = [
    "aiban-runtime",
    "aiban-scene-control",
    "aiban-scene-router",
    "aiban-scene-entry",
    "aiban-label",
    "aiban-result",
    "aiban-result-db",
    "aiban-api-trigger",
    "aiban-api-output",
    "aiban-socket-output",
    "aiban-sequence-logic",
    "aiban-monitor-logic",
    "aiban-timer-record",
    "aiban-custom-flow",
];

const REQUIRED_DOCS = [
    "README.md",
    "WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md",
    "WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md",
    "docs/OPERATIONS.md",
    "docs/REAL_SDK_TEST.md",
    "docs/TEST_REPORT_T16_T20_2026-08-01.md",
    "docs/ADVANCED_LOGIC_CONTRACTS.md",
    "docs/CUSTOM_FLOW_CONTRACT.md",
    "docs/RELEASE_GATE_V2.md",
    "docs/WORKFLOW_V2_PARITY.md",
];

const REQUIRED_EXAMPLES = [
    "node-red-contrib-aiban-workflow/examples/group-scene-flow.json",
    "node-red-contrib-aiban-workflow/examples/t19-t20-logic-flow.json",
    "node-red-contrib-aiban-workflow/examples/t21-custom-flow.json",
];

const LEGACY_PATHS = [
    "icameraapi",
    "scenes",
    "core",
    "workflows",
];

const FORBIDDEN_PYTHON_DEPENDENCIES = ["pyzmq", "pymysql"];

const NODE_RED_CACHE_FILES = [
    "node-red/.config.nodes.json",
    "node-red/.config.nodes.json.backup",
];

const GENERATED_NPM_LOCK_FILES = [
    {
        path: "node-red/node_modules/.package-lock.json",
        packageKey: "../node-red-contrib-aiban-workflow",
    },
    {
        path: "node-red-contrib-aiban-workflow/node_modules/.package-lock.json",
        packageKey: null,
    },
];

function exists(root, relativePath) {
    return fs.existsSync(path.join(root, relativePath));
}

function readText(root, relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function hasAcceptedFieldEvidence(root) {
    const acceptancePath = "docs/FIELD_ACCEPTANCE_V2_0.md";
    if (!exists(root, acceptancePath)) return false;
    return /status:\s*ACCEPTED/i.test(readText(root, acceptancePath));
}

function evaluateReleaseGate(root = process.cwd(), env = process.env) {
    const checks = [];
    const blockers = [];
    const warnings = [];
    const packagePath = "node-red-contrib-aiban-workflow/package.json";

    if (!exists(root, packagePath)) {
        blockers.push(`${packagePath} not found`);
    } else {
        const pkg = JSON.parse(readText(root, packagePath));
        const nodes = pkg["node-red"]?.nodes || {};
        const packageVersionOk = /^2\.0\./.test(String(pkg.version || ""));
        checks.push({ id: "package:version-2.0", ok: packageVersionOk });
        if (!packageVersionOk) blockers.push(`Node-RED package version is not 2.0.x: ${pkg.version || "missing"}`);
        const authorOk = !pkg.author || !/^your name$/i.test(String(pkg.author).trim());
        checks.push({ id: "package:author-metadata", ok: authorOk });
        if (!authorOk) blockers.push("Node-RED package author metadata is still a placeholder");
        for (const nodeName of Object.keys(nodes)) {
            if (!nodeName.startsWith("aiban-")) blockers.push(`non-2.0 node is still published: ${nodeName}`);
        }
        if (pkg.dependencies?.zeromq) blockers.push("zeromq dependency is still published in the 2.0 node package");
        for (const nodeName of REQUIRED_NODES) {
            const jsFile = nodes[nodeName];
            const htmlFile = jsFile ? jsFile.replace(/\.js$/, ".html") : "";
            const ok = Boolean(jsFile)
                && exists(root, `node-red-contrib-aiban-workflow/${jsFile}`)
                && exists(root, `node-red-contrib-aiban-workflow/${htmlFile}`);
            checks.push({ id: `node:${nodeName}`, ok });
            if (!ok) blockers.push(`Node-RED node ${nodeName} is not fully registered`);
        }
    }

    for (const legacyPath of LEGACY_PATHS) {
        const ok = !exists(root, legacyPath);
        checks.push({ id: `legacy-path:${legacyPath}`, ok });
        if (!ok) blockers.push(`legacy 1.0 path is still present: ${legacyPath}`);
    }

    const requirementsPath = "requirements-v2.txt";
    if (exists(root, requirementsPath)) {
        const requirements = readText(root, requirementsPath).toLowerCase();
        for (const dependency of FORBIDDEN_PYTHON_DEPENDENCIES) {
            const ok = !new RegExp(`^\\s*${dependency}(?:[<>=!~]|\\s|$)`, "mi").test(requirements);
            checks.push({ id: `legacy-python-dependency:${dependency}`, ok });
            if (!ok) blockers.push(`legacy 1.0 Python dependency is still present: ${dependency}`);
        }
    }

    const nodeRedLockPath = "node-red/package-lock.json";
    if (exists(root, nodeRedLockPath) && exists(root, packagePath)) {
        const lock = JSON.parse(readText(root, nodeRedLockPath));
        const pkg = JSON.parse(readText(root, packagePath));
        const linkedPackage = lock.packages?.["../node-red-contrib-aiban-workflow"] || {};
        const versionOk = linkedPackage.version === pkg.version;
        const noZeroMq = !linkedPackage.dependencies?.zeromq;
        checks.push({ id: "node-red-lock:package-version", ok: versionOk });
        checks.push({ id: "node-red-lock:no-zeromq", ok: noZeroMq });
        if (!versionOk) blockers.push("Node-RED lockfile has stale workflow package metadata");
        if (!noZeroMq) blockers.push("Node-RED lockfile still contains the 1.0 zeromq dependency");
    }

    if (exists(root, packagePath)) {
        const packageVersion = JSON.parse(readText(root, packagePath)).version;
        for (const cachePath of NODE_RED_CACHE_FILES) {
            let ok = true;
            if (exists(root, cachePath)) {
                try {
                    const cache = JSON.parse(readText(root, cachePath));
                    const cachedPackage = cache["node-red-contrib-aiban-workflow"] || {};
                    const cachedNodes = Object.keys(cachedPackage.nodes || {});
                    ok = cachedPackage.version === packageVersion
                        && cachedNodes.every(nodeName => nodeName.startsWith("aiban-"));
                } catch {
                    ok = false;
                }
            }
            checks.push({ id: `node-red-cache:${cachePath}`, ok });
            if (!ok) blockers.push(`Node-RED runtime cache still contains 1.0 node metadata: ${cachePath}`);
        }
        for (const lockSpec of GENERATED_NPM_LOCK_FILES) {
            let ok = true;
            if (exists(root, lockSpec.path)) {
                try {
                    const generatedLock = JSON.parse(readText(root, lockSpec.path));
                    const recordedVersion = lockSpec.packageKey
                        ? generatedLock.packages?.[lockSpec.packageKey]?.version
                        : generatedLock.version;
                    ok = recordedVersion === packageVersion
                        && !/"zeromq"\s*:/.test(JSON.stringify(generatedLock));
                } catch {
                    ok = false;
                }
            }
            checks.push({ id: `generated-npm-lock:${lockSpec.path}`, ok });
            if (!ok) blockers.push(`generated npm lock cache has stale 1.0 metadata: ${lockSpec.path}`);
        }
    }

    for (const doc of REQUIRED_DOCS) {
        const ok = exists(root, doc);
        checks.push({ id: `doc:${doc}`, ok });
        if (!ok) blockers.push(`required document missing: ${doc}`);
    }

    for (const example of REQUIRED_EXAMPLES) {
        const ok = exists(root, example);
        checks.push({ id: `example:${example}`, ok });
        if (!ok) blockers.push(`required example missing: ${example}`);
    }

    if (exists(root, "WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md")) {
        const spec = readText(root, "WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md");
        for (const task of ["T21", "T22"]) {
            const ok = new RegExp(`\\| ${task} \\|[^\\n]+\\| 100% \\| DONE \\| 0 \\|`).test(spec);
            checks.push({ id: `task:${task}`, ok });
            if (!ok) warnings.push(`${task} is not recorded as DONE in task spec`);
        }
        for (const task of ["T16", "T17", "T18"]) {
            const ok = new RegExp(`\\| ${task} \\|[^\\n]+\\| 100% \\| DONE \\| 0 \\|`).test(spec);
            checks.push({ id: `field:${task}`, ok });
            if (!ok) blockers.push(`${task} field acceptance is not DONE`);
        }
    }

    const fieldAccepted = env.AIBAN_RELEASE_FIELD_ACCEPTED === "1" || hasAcceptedFieldEvidence(root);
    checks.push({ id: "field:acceptance-signoff", ok: fieldAccepted });
    if (!fieldAccepted) blockers.push("field acceptance sign-off is missing");

    const releasable = blockers.length === 0;
    return {
        releasable,
        status: releasable ? "PASS" : "BLOCKED",
        checked_at: new Date().toISOString(),
        checks,
        blockers,
        warnings,
    };
}

function main() {
    const rootArg = process.argv.find(arg => arg.startsWith("--root="));
    const root = rootArg ? path.resolve(rootArg.slice("--root=".length)) : path.resolve(__dirname, "..");
    const result = evaluateReleaseGate(root);
    if (process.argv.includes("--json")) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
        console.log(`AiBan Workflow 2.0 release gate: ${result.status}`);
        for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
        for (const warning of result.warnings) console.log(`WARN ${warning}`);
    }
    process.exitCode = result.releasable ? 0 : 2;
}

if (require.main === module) main();

module.exports = {
    evaluateReleaseGate,
    REQUIRED_NODES,
    REQUIRED_DOCS,
    REQUIRED_EXAMPLES,
    LEGACY_PATHS,
    FORBIDDEN_PYTHON_DEPENDENCIES,
    NODE_RED_CACHE_FILES,
    GENERATED_NPM_LOCK_FILES,
};
