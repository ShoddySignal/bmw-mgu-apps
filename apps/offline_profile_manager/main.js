'use strict';

const mgu = require('./kit/mgu');
const kit = require('./kit/diag');
const sdk = require('oap-sdk');
const { start } = require('./ui');

mgu.run({ start: (ctx) => start(ctx, kit, sdk) });
