'use strict';

const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const { Probe } = require('./probe');
const { bindUi } = require('./ui');

mgu.run({
    start(ctx) {
        const probe = new Probe(ctx.signals, ctx.log, Car.selectionOf);
        bindUi(ctx, probe);
        return probe.start();
    },
});
