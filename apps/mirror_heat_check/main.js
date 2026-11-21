'use strict';

const mgu = require('./kit/mgu');
const diagKit = require('./kit/diag');
const { MirrorDiag } = require('./protocol');
const { Monitor } = require('./monitor');
const { bindUi } = require('./ui');

mgu.run({
    async start(ctx) {
        const link = new diagKit.Diag(ctx.signals, ctx.log);
        link.quiet = true;
        link.busyLog = false;
        const monitor = new Monitor(new MirrorDiag(link, diagKit));
        const update = bindUi(ctx, monitor);
        link.on('available', (up) => {
            if (!up) monitor.disconnected();
            update();
        });
        await link.init();
        update();
    }
});
