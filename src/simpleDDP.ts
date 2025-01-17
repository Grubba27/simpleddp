import DDP from "./ddp/ddp";
import EJSON from "ejson";

import { isEqual } from './helpers/isEqual.js';
import { fullCopy } from './helpers/fullCopy.js';

import { ddpEventListener } from './classes/ddpEventListener.js';
import { ddpSubscription } from './classes/ddpSubscription.js';
import { ddpCollection } from './classes/ddpCollection.js';

function uniqueIdFuncGen() {
  let idCounter = 0;

  return function () {
    return idCounter++;
  }
}

const simpleDDPcounter = uniqueIdFuncGen();

function connectPlugins(plugins: any[], ...places: any[]) {
  if (Array.isArray(plugins)) {
    plugins.forEach((p) => {
      places.forEach((place) => {
        if (p[place]) {
          // @ts-ignore
          p[place].call(this);
        }
      });
    });
  }
}

export type DDPMessage =
  {
    collection: PropertyKey;
    id: any; fields: {};
    cleared: any[];
    f:
      (p: { removed: boolean; added: any; changed: boolean }) => any;
    msg: string;
    name: string;
    params: any[];
    result: any;
    sub: any;
    subs: string | string[]
    filter: (newObjFullCopy: { _id: any }, number: number, collection1: any[]) => any;
  };

export type SimpleDDPConnectOptions = {
  endpoint: string,
  SocketConstructor: typeof WebSocket,
  autoConnect?: boolean,
  autoReconnect?: boolean,
  reconnectInterval?: number,
  clearDataOnReconnection?: boolean,
  maxTimeout?: number,
  cleanQueue?: boolean,
  plugins?: any[],
  ddpVersion?: string,

}

/**
 * Creates an instance of simpleDDP class. After being constructed, the instance will
 * establish a connection with the DDP server and will try to maintain it open.
 * @version 2.2.4
 */
class simpleDDP {
  private _id = simpleDDPcounter();
  private _opGenId = uniqueIdFuncGen();
  private _opts: SimpleDDPConnectOptions
  ddpConnection: DDP;
  subs: ddpSubscription[] = [];
  /**
   All collections data recieved from server.

   @type Object
   */
  collections: {
    [key: PropertyKey]: any[]
  } = {};
  onChangeFuncs: DDPMessage[] = [];

  /**
   Whether the client is connected to server.

   @type Boolean
   */
  connected = false;
  maxTimeout: number | undefined;
  clearDataOnReconnection: boolean;
  tryingToConnect: boolean;
  tryingToDisconnect = false;
  willTryToReconnect: boolean;
  connectedEvent: { stop: () => void; start: () => void };
  connectedEventRestartSubs: { stop: () => void; start: () => void };
  disconnectedEvent: { stop: () => void; start: () => void };
  addedEvent: { stop: () => void; start: () => void };
  changedEvent: { stop: () => void; start: () => void };
  removedEvent: { stop: () => void; start: () => void };

  /**
   * @param {Object} options
   * @param {string} options.endpoint - The location of the websocket server. Its format depends on the type of socket you are using. If you are using https connection you have to use wss:// protocol.
   * @param {Function} options.SocketConstructor - The constructor function that will be used to construct the socket. Meteor (currently the only DDP server available) supports websockets and SockJS sockets. So, practically speaking, this means that on the browser you can use either the browser's native WebSocket constructor or the SockJS constructor provided by the SockJS library. On the server you can use whichever library implements the websocket protocol (e.g. faye-websocket).
   * @param {boolean} [options.autoConnect=true] - Whether to establish the connection to the server upon instantiation. When false, one can manually establish the connection with the connect method.
   * @param {boolean} [options.autoReconnect=true] - Whether to try to reconnect to the server when the socket connection closes, unless the closing was initiated by a call to the disconnect method.
   * @param {number} [options.reconnectInterval=1000] - The interval in ms between reconnection attempts.
   * @param {boolean} [options.clearDataOnReconnection=true] - Whether to clear all collections data after a reconnection. This invokes fake `removed` messages on every document.
   * @param {number} [options.maxTimeout=undefined] - Maximum wait for a response from the server to the method call. Default no maxTimeout.
   * @param {Array} [plugins] - Array of plugins.
   * @return {simpleDDP} - A new simpleDDP instance.
   * @example
   * var opts = {
   *    endpoint: "ws://someserver.com/websocket",
   *    SocketConstructor: WebSocket,
   *    reconnectInterval: 5000
   * };
   * var server = new simpleDDP(opts);
   */
  constructor(opts: SimpleDDPConnectOptions, plugins?: any[]) {

    this._opts = opts;
    this.ddpConnection = new DDP(opts);


    this.maxTimeout = opts.maxTimeout;
    this.clearDataOnReconnection = opts.clearDataOnReconnection === undefined ? true : opts.clearDataOnReconnection;
    this.tryingToConnect = opts.autoConnect === undefined ? true : opts.autoConnect;
    this.willTryToReconnect = opts.autoReconnect === undefined ? true : opts.autoReconnect;

    // @ts-ignore
    let pluginConnector = connectPlugins.bind(this, plugins);

    // plugin init section
    pluginConnector('init', 'beforeConnected');

    this.connectedEvent = this.on('connected', () => {
      this.connected = true;
      this.tryingToConnect = false;
    });

    pluginConnector('afterConnected', 'beforeSubsRestart');

    this.connectedEventRestartSubs = this.on('connected', () => {
      if (this.clearDataOnReconnection) {
        // we have to clean local collections
        this.clearData().then(() => {
          this.ddpConnection.emit('clientReady');
          this.restartSubs();
        });
      } else {
        this.ddpConnection.emit('clientReady');
        this.restartSubs();
      }
    });

    pluginConnector('afterSubsRestart', 'beforeDisconnected');

    this.disconnectedEvent = this.on('disconnected', () => {
      this.connected = false;
      this.tryingToDisconnect = false;
      this.tryingToConnect = this.willTryToReconnect;
    });

    pluginConnector('afterDisconnected', 'beforeAdded');

    this.addedEvent = this.on('added', (m: DDPMessage) => this.dispatchAdded(m));
    pluginConnector('afterAdded', 'beforeChanged');
    this.changedEvent = this.on('changed', (m: DDPMessage) => this.dispatchChanged(m));
    pluginConnector('afterChanged', 'beforeRemoved');
    this.removedEvent = this.on('removed', (m: DDPMessage) => this.dispatchRemoved(m));
    pluginConnector('afterRemoved', 'after');
  }

  /**
   * Restarts all subs.
   * @private
   */
  restartSubs() {
    this.subs.forEach((sub) => {
      if (sub.isOn()) {
        sub.restart();
      }
    });
  }

  /**
   * Use this for fetching the subscribed data and for reactivity inside the collection.
   * @public
   * @param {string} name - Collection name.
   * @return {ddpCollection}
   */
  collection<T>(name: string) {
    return new ddpCollection<T>(name, this);
  }

  /**
   * Dispatcher for ddp added messages.
   * @private
   * @param {Object} m - DDP message.
   */
  dispatchAdded(m: DDPMessage) {
    //m везде одинаковое, стоит наверное копировать
    // m is always the same, it is probably worth copying
    if (this.collections.hasOwnProperty(m.collection)) {
      let i = this.collections[m.collection].findIndex((obj) => {
        return obj._id == m.id;
      });
      if (i > -1) {
        // new sub knows nothing about old sub
        this.collections[m.collection].splice(i, 1);
      }
    }
    if (!this.collections.hasOwnProperty(m.collection)) this.collections[m.collection] = [];
    let newObj = Object.assign({ _id: m.id }, m.fields);
    let i = this.collections[m.collection].push(newObj);
    let fields: {
      [key: string]: number;
    } = {};
    if (m.fields) {
      Object.keys(m.fields).map((p) => {
        fields[p] = 1;
      });
    }
    this.onChangeFuncs.forEach((l: DDPMessage) => {
      if (l.collection == m.collection) {
        let hasFilter = l.hasOwnProperty('filter');
        let newObjFullCopy = fullCopy(newObj);
        if (!hasFilter) {
          l.f({ changed: false, added: newObjFullCopy, removed: false });
        } else if (hasFilter && l.filter(newObjFullCopy, i - 1, this.collections[m.collection])) {
          // @ts-ignore
          l.f({ prev: false, next: newObjFullCopy, fields, fieldsChanged: newObjFullCopy, fieldsRemoved: [] });
        }
      }
    });
  }

  /**
   * Dispatcher for ddp changed messages.
   * @private
   * @param {Object} m - DDP message.
   */
  dispatchChanged(m: DDPMessage) {
    if (!this.collections.hasOwnProperty(m.collection)) this.collections[m.collection] = [];
    let i = this.collections[m.collection].findIndex((obj) => {
      return obj._id == m.id;
    });
    if (i > -1) {
      const t = this.collections[m.collection][i];
      let prev: typeof t = fullCopy(this.collections[m.collection][i]);
      let fields: {
        [key: string]: number;
      } = {}, fieldsChanged = {}, fieldsRemoved: any[] = [];
      if (m.fields) {
        fieldsChanged = m.fields;
        Object.keys(m.fields).map((p) => {
          fields[p] = 1;
        });
        Object.assign(this.collections[m.collection][i], m.fields);
      }
      if (m.cleared) {
        fieldsRemoved = m.cleared;
        m.cleared.forEach((fieldName) => {
          fields[fieldName] = 0;
          delete this.collections[m.collection][i][fieldName];
        });
      }
      let next = this.collections[m.collection][i];
      this.onChangeFuncs.forEach((l) => {
        if (l.collection == m.collection) {
          // perhaps add a parameter inside l object to choose if full copy should occur
          let hasFilter = l.hasOwnProperty('filter');
          if (!hasFilter) {
            l.f({
              // @ts-ignore
              changed: { prev, next: fullCopy(next), fields, fieldsChanged, fieldsRemoved },
              added: false,
              removed: false
            });
          } else {
            let fCopyNext = fullCopy(next);
            let prevFilter = l.filter(prev, i, this.collections[m.collection]);
            let nextFilter = l.filter(fCopyNext, i, this.collections[m.collection]);
            if (prevFilter || nextFilter) {
              l.f({
                // @ts-ignore
                prev,
                next: fCopyNext,
                fields,
                fieldsChanged,
                fieldsRemoved,
                predicatePassed: [prevFilter, nextFilter]
              });
            }
          }
        }
      });
    } else {
      this.dispatchAdded(m);
    }
  }

  /**
   * Dispatcher for ddp removed messages.
   * @private
   * @param {Object} m - DDP message.
   */
  dispatchRemoved(m: DDPMessage) {
    if (!this.collections.hasOwnProperty(m.collection)) this.collections[m.collection] = [];
    let i = this.collections[m.collection].findIndex((obj) => {
      return obj._id == m.id;
    });
    if (i > -1) {
      let prevProps;
      let removedObj = this.collections[m.collection].splice(i, 1)[0];
      this.onChangeFuncs.forEach((l) => {
        if (l.collection == m.collection) {
          let hasFilter = l.hasOwnProperty('filter');
          if (!hasFilter) {
            // возможно стоит сделать fullCopy, чтобы было как в случае dispatchAdded и dispatchChanged
            // perhaps you should make a fullCopy so that it is like in the case of dispatchAdded and dispatchChanged
            l.f({ changed: false, added: false, removed: removedObj });
          } else {
            if (l.filter(removedObj, i, this.collections[m.collection])) {
              // @ts-ignore
              l.f({ prev: removedObj, next: false });
            }
          }
        }
      });
    }
  }

  /**
   * Connects to the ddp server. The method is called automatically by the class constructor if the autoConnect option is set to true (default behavior).
   * @public
   * @return {Promise} - Promise which resolves when connection is established.
   */
  connect() {
    this.willTryToReconnect = this._opts.autoReconnect === undefined ? true : this._opts.autoReconnect;
    return new Promise<void>((resolve, reject) => {
      if (!this.tryingToConnect) {
        this.ddpConnection.connect();
        this.tryingToConnect = true;
      }
      if (!this.connected) {
        let stoppingInterval: number | undefined;

        const connectionHandler = this.on('connected', () => {
          clearTimeout(stoppingInterval);
          connectionHandler.stop();
          this.tryingToConnect = false;
          resolve();
        });

        if (this.maxTimeout) {
          stoppingInterval = setTimeout(() => {
            connectionHandler.stop();
            this.tryingToConnect = false;
            reject(new Error('MAX_TIMEOUT_REACHED'));
          }, this.maxTimeout);
        }
      } else {
        resolve();
      }
    });
  }

  /**
   * Disconnects from the ddp server by closing the WebSocket connection. You can listen on the disconnected event to be notified of the disconnection.
   * @public
   * @return {Promise} - Promise which resolves when connection is closed.
   */
  disconnect() {
    this.willTryToReconnect = false;
    return new Promise<void>((resolve, reject) => {
      if (!this.tryingToDisconnect) {
        this.ddpConnection.disconnect();
        this.tryingToDisconnect = true;
      }
      if (this.connected) {
        let connectionHandler = this.on('disconnected', () => {
          connectionHandler.stop();
          this.tryingToDisconnect = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Calls a remote method with arguments passed in array.
   * @public
   * @param {string} method - Name of the server publication.
   * @param {Array} [arguments] - Array of parameters to pass to the remote method. Pass an empty array or don't pass anything if you do not wish to pass any parameters.
   * @param {boolean} [atBeginning=false] - If true puts method call at the beginning of the requests queue.
   * @return {Promise} - Promise object, which resolves when receives a result send by server and rejects when receives an error send by server.
   * @example
   * server.apply("method1").then(function(result) {
   *	console.log(result); //show result message in console
   *    if (result.someId) {
   *        //server sends us someId, lets call next method using this id
   *        return server.apply("method2",[result.someId]);
   *    } else {
   *        //we didn't recieve an id, lets throw an error
   *        throw "no id sent";
   *    }
   * }).then(function(result) {
   *    console.log(result); //show result message from second method
   * }).catch(function(error) {
   *    console.log(result); //show error message in console
   * });
   */
  apply<T extends any[], R>(method: string, args: T, atBeginning = false) {
    return new Promise((resolve, reject) => {
      const methodId = this.ddpConnection.method(method, args ? args : [], atBeginning);
      const _self = this;

      let stoppingInterval: number | undefined;

      function onMethodResult(message: { id: string; error: any; result: unknown; }) {
        if (message.id == methodId) {
          clearTimeout(stoppingInterval);
          if (!message.error) {
            resolve(message.result);
          } else {
            reject(message.error);
          }
          _self.ddpConnection.removeListener('result', onMethodResult);
        }
      }

      this.ddpConnection.on("result", onMethodResult);

      if (this.maxTimeout) {
        stoppingInterval = setTimeout(() => {
          this.ddpConnection.removeListener('result', onMethodResult);
          reject(new Error('MAX_TIMEOUT_REACHED'));
        }, this.maxTimeout);
      }
    });
  }

  /**
   * Calls a remote method with arguments passed after the first argument.
   * Syntactic sugar for @see apply.
   * @public
   * @param {string} method - Name of the server publication.
   * @param {...any} [args] - List of parameters to pass to the remote method. Parameters are passed as function arguments.
   * @return {Promise} - Promise object, which resolves when receives a result send by server and rejects when receives an error send by server.
   */
  call<TArgs extends any[], R = unknown>(method: string, ...args: TArgs): Promise<R> {
    return this.apply(method, args) as Promise<R>;
  }

  /**
   * Tries to subscribe to a specific publication on server.
   * Starts the subscription if the same subscription exists.
   * @public
   * @param {string} pubname - Name of the publication on server.
   * @param {Array} [arguments] - Array of parameters to pass to the remote method. Pass an empty array or don't pass anything if you do not wish to pass any parameters.
   * @return {ddpSubscription} - Subscription.
   */
  sub(pubname: string, args: any[]) {
    const k = this.apply('foo', [123, 2])
    let hasSuchSub = this.subs.find((sub) => {
      return sub.pubname == pubname && isEqual(sub.args, Array.isArray(args) ? args : []);
    });
    if (!hasSuchSub) {
      let i = this.subs.push(new ddpSubscription(pubname, Array.isArray(args) ? args : [], this));
      return this.subs[i - 1];
    } else {
      if (hasSuchSub.isStopped()) hasSuchSub.start();
      return hasSuchSub;
    }
  }

  /**
   * Tries to subscribe to a specific publication on server.
   * Syntactic sugar for @see sub.
   * @public
   * @param {string} pubname - Name of the publication on server.
   * @param {...any} [args] - List of parameters to pass to the remote method. Parameters are passed as function arguments.
   * @return {ddpSubscription} - Subscription.
   */
  subscribe(pubname: string, ...args: any[]) {
    return this.sub(pubname, args);
  }

  /**
   * Starts listening server for basic DDP event running f each time the message arrives.
   * @public
   * @param {string} event - Any event name from DDP specification.
   * Default suppoted events: `connected`, `disconnected`, `added`, `changed`, `removed`, `ready`, `nosub`, `error`, `ping`, `pong`.
   * @param {Function} f - Function which receives a message from a DDP server as a first argument each time server is invoking event.
   * @return {ddpEventListener}
   * @example
   * server.on('connected', () => {
   *     // you can show a success message here
   * });
   *
   * server.on('disconnected', () => {
   *     // you can show a reconnection message here
   * });
   */
  on(event: string, f: (message: DDPMessage, id: string) => void) {
    return ddpEventListener(event, f, this);
  }

  /**
   * Stops all reactivity.
   */
  stopChangeListeners() {
    this.onChangeFuncs = [];
  }

  /**
   * Removes all documents like if it was removed by the server publication.
   * @public
   * @return {Promise} - Resolves when data is successfully removed.
   */
  clearData() {
    return new Promise<void>((resolve, reject) => {
      let totalDocuments = 0;
      Object.keys(this.collections).forEach((collection) => {
        totalDocuments += Array.isArray(this.collections[collection]) ? this.collections[collection].length : 0;
      });

      if (totalDocuments === 0) {
        resolve();
      } else {
        let counter = 0;
        let uniqueId = this._id + "-" + this._opGenId();

        const listener = this.on('removed', (m, id) => {
          if (id == uniqueId) {
            counter++;
            if (counter == totalDocuments) {
              listener.stop();
              resolve();
            }
          }
        });

        Object.keys(this.collections).forEach((collection) => {
          this.collections[collection].forEach((doc) => {
            this.ddpConnection.emit('removed', {
              msg: 'removed',
              id: doc.id,
              collection: collection
            }, uniqueId);
          });
        });
      }
    });
  }

  /**
   * Imports the data like if it was published by the server.
   * @public
   * @param {Object|string} data - ESJON string or EJSON.
   * @return {Promise} - Resolves when data is successfully imported.
   */
  importData(data: string | object) {
    return new Promise<void>((resolve, reject) => {
      let c = typeof data === 'string' ? EJSON.parse(data) : data;

      let totalDocuments = 0;
      Object.keys(c).forEach((collection) => {
        totalDocuments += Array.isArray(c[collection]) ? c[collection].length : 0;
      });

      let counter = 0;
      let uniqueId = this._id + "-" + this._opGenId();

      const listener = this.on('added', (m, id) => {
        if (id == uniqueId) {
          counter++;
          if (counter == totalDocuments) {
            listener.stop();
            resolve();
          }
        }
      });

      Object.keys(c).forEach((collection) => {
        c[collection].forEach((doc: { id: any; }) => {

          let docFields = Object.assign({}, doc);
          delete docFields['id'];

          this.ddpConnection.emit('added', {
            msg: 'added',
            id: doc.id,
            collection: collection,
            fields: docFields
          }, uniqueId);
        });
      });
    });
  }

  /**
   * Exports the data
   * @public
   * @param {string} [format='string'] - Possible values are 'string' (EJSON string) and 'raw' (EJSON).
   * @return {Object|string} - EJSON string or EJSON.
   */
  exportData(format?: string) {
    if (format === undefined || format == 'string') {
      return EJSON.stringify(this.collections);
    } else if (format == 'raw') {
      return fullCopy(this.collections);
    }
  }

  /**
   * Marks every passed @see ddpSubscription object as ready like if it was done by the server publication.
   * @public
   * @param {Array} subs - Array of @see ddpSubscription objects.
   * @return {Promise} - Resolves when all passed subscriptions are marked as ready.
   */
  markAsReady(subs: any[]) {
    return new Promise<void>((resolve, reject) => {
      let uniqueId = this._id + "-" + this._opGenId();

      this.ddpConnection.emit('ready', {
        msg: 'ready',
        subs: subs.map(sub => sub._getId())
      }, uniqueId);

      const listener = this.on('ready', (m, id) => {
        if (id == uniqueId) {
          listener.stop();
          resolve();
        }
      });
    });
  }

}

export default simpleDDP;
