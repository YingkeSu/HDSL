/**
 * TEST/FIXTURE ONLY subpath (`@hdsl/contracts/testing`).
 *
 * Holds the in-memory reference port and the method × fixture × expected-error
 * table. These are deliberately kept out of the production `@hdsl/contracts`
 * entry (issue #21 review F5) so a launcher consumer cannot bind to the test
 * double by accident. This is not persistence and not launcher behavior;
 * T004–T006 implement the real `ContractPort`.
 */
export * from './reference-port.js';
export * from './fixtures.js';
