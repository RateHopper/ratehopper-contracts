module.exports = {
    // Mocks are test-only scaffolding — exclude from instrumentation/report.
    skipFiles: ["mocks/"],
    // RatehopperUniV3Positions compiles with viaIR; let coverage configure the
    // Yul optimizer so instrumentation doesn't trip "stack too deep".
    configureYulOptimizer: true,
    mocha: {
        parallel: false,
    },
};
