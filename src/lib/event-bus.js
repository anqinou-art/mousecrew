// event-bus.js — one EventEmitter, module-scoped.
// Modules that cannot see each other's closures talk through this instead of
// growing a dependency edge. Events in use:
//   group:post              -> route a message into the single group-message entry point
//   group:broadcast         -> push a payload to group SSE clients
//   group:dispatch_mentions -> wake every agent @mentioned in a piece of text
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);
module.exports = bus;
