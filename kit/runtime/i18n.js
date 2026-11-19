'use strict';

const t = (value) => String(value == null ? '' : value);
const getLanguage = () => 'en';

module.exports = { t, dict: {}, getLanguage };
