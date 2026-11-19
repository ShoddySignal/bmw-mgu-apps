'use strict';

const mgu = require('./kit/mgu');
const diagKit = require('./kit/diag');
const { MirrorDiag } = require('./protocol');
const { Parking, monotonicMs } = require('./parking');
const { Monitor } = require('./monitor');
const { bindUi } = require('./ui');

mgu.run({
    async start(ctx) {
        const link = new diagKit.Diag(ctx.signals, ctx.log);
        link.quiet = true;
        link.busyLog = false;
        const parking = new Parking(ctx.signals, ctx.log, monotonicMs);
        const monitor = new Monitor(new MirrorDiag(link, diagKit), () => parking.parked(), monotonicMs);
        const render = bindUi(ctx, monitor);
        link.on('available', (up) => {
            if (!up) monitor.interrupt();
            render();
        });
        await Promise.all([link.init(), parking.init()]);
        render();
    }
});
