'use strict';

const FREE_TEXT = '02076b22-d19b-4aef-9e8c-0d7305d8b88c';
const TITLE = 4;
const TEXT = 102;
const ACCEPTED = 105;
const FAILED = Symbol('speller failed');

async function enterProfileName(app, cancellation) {
    let deadline, cancelled = false, proxy, subscription;
    let deliver;
    const outcome = new Promise((resolve) => { deliver = resolve; });
    let value = '';

    function receive(update) {
        if (cancelled || !update) return;
        const params = update.interactionParameters;
        if (params && typeof params.has === 'function') {
            if (params.has(TEXT)) value = String(params.get(TEXT));
            if (params.has(ACCEPTED)) { deliver(value); return; }
        }
        if (update.interactionState === 'FAILED') deliver(FAILED);
        if (update.interactionState === 'ABORTED' || update.interactionState === 'COMPLETED') deliver(null);
    }

    function unsubscribe() {
        if (subscription == null) return;
        const id = subscription;
        subscription = null;
        Promise.resolve().then(() => proxy.notify.unsubscribe(id)).catch(() => {});
    }

    async function open() {
        const factory = await app.getUseCaseFactory();
        if (cancelled) return;
        const instance = await factory.create(FREE_TEXT);
        if (cancelled) return;
        proxy = instance.proxy;
        await proxy.init();
        if (cancelled) return;
        await proxy.waitUntilAvailable();
        if (cancelled) return;
        if (await proxy.interactionState.getValue() !== 'READY') throw new Error('Text input is unavailable');
        if (cancelled) return;
        subscription = await proxy.notify.subscribe(receive);
        if (cancelled) { unsubscribe(); return; }
        await proxy.start({ token: instance.token, startParameters: new Map([[TITLE, 'New profile name']]) });
    }

    async function readInput() {
        await Promise.race([open(), new Promise((resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Text input did not open')), 5000);
        })]);
        clearTimeout(deadline);
        const result = await outcome;
        if (result === FAILED) throw new Error('Text input failed');
        return result;
    }

    try {
        return await Promise.race([readInput(), cancellation]);
    } finally {
        cancelled = true;
        clearTimeout(deadline);
        unsubscribe();
    }
}

module.exports = { enterProfileName };
