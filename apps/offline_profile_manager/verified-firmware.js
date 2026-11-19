'use strict';

// Explicitly approved builds for on-car testing. Writes still require user
// confirmation, fresh parking signals and a parsable profile list.
module.exports = [{
    index: '0F25B0',
    version: 'L18_22w18.3-1-6',
    variantId: 'mgu-high',
    // This build appends data after the seven documented E333 fields.
    allowExtraAccountData: true,
    actions: ['create', 'pia', 'login', 'rename']
}];
