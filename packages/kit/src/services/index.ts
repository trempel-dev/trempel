// Services: contracts with a mandatory mock (contract.ts), the registry (services.ts), the kit's
// standard contracts (standard.ts) and the bridge to the old Platform (platform.ts).

export { contract, extend, adapt, sticky, once } from './contract.js';
export type { Contract, ContractSpec, ServiceContext, EventRef, EventDecl, EventKind, MockModes, Impl, Named, Factory, Api, StateOf, EventsOf, AnyContract, PayloadArgs } from './contract.js';
export { Services, ServiceError, services, inject, listen, provide, currentServices, setCurrentServices, parseModeQuery } from './services.js';
export type { Mounted, ServiceLogEntry, ServiceStore, ServiceInfo } from './services.js';
export { Lifecycle, SaveService, AudioService, Language, AdsService, Wallet, Iap, Leaderboard, KIT_CONTRACTS } from './standard.js';
export type { SpendResult, Product, PurchaseResult, LeaderEntry } from './standard.js';
export { platformProviders, platformFacade } from './platform.js';
export type { Provision } from './platform.js';
