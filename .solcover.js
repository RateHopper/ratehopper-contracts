module.exports = {
    // Mocks are test-only scaffolding — exclude from instrumentation/report.
    skipFiles: ["mocks/"],
    // RatehopperUniV3Positions compiles with viaIR; instrumented branches in
    // large frames (e.g. switchLp) trip "stack too deep" unless the Yul
    // optimizer pipeline is reduced to the minimum (Foundry ir-minimum
    // equivalent). Supersedes configureYulOptimizer, which stopped being
    // enough once switchLp grew.
    irMinimum: true,
    mocha: {
        parallel: false,
    },
};
