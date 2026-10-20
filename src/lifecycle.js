// The artifact lifecycle as a transition table — the one place a state machine
// earns its keep. Every mutation goes through transition(); a pair missing from
// the table is a 409 that names what is allowed.
//
//   (none) --create--> active --update--> active
//   active --trash-->  trashed --restore--> active
//   trashed --purge--> purged   (rows hard-deleted; terminal)

export const NONE = 'none';
export const ACTIVE = 'active';
export const TRASHED = 'trashed';
export const PURGED = 'purged';

export const TRANSITIONS = new Map([
  [`${NONE}:create`, ACTIVE],
  [`${ACTIVE}:update`, ACTIVE],
  [`${ACTIVE}:trash`, TRASHED],
  [`${TRASHED}:restore`, ACTIVE],
  [`${TRASHED}:purge`, PURGED],
]);

export const EVENTS = [...new Set([...TRANSITIONS.keys()].map((k) => k.split(':')[1]))];

export class InvalidTransition extends Error {
  constructor(state, event) {
    const allowed = [...TRANSITIONS.keys()]
      .filter((k) => k.startsWith(`${state}:`))
      .map((k) => k.split(':')[1])
      .sort();
    super(`cannot '${event}' an artifact that is '${state}'; allowed: [${allowed.map((e) => `'${e}'`).join(', ')}]`);
    this.status = 409;
  }
}

/** Pure: the next state, or throw InvalidTransition. */
export function transition(state, event) {
  const next = TRANSITIONS.get(`${state}:${event}`);
  if (next === undefined) throw new InvalidTransition(state, event);
  return next;
}
