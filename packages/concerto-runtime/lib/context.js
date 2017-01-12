/*
 * IBM Confidential
 * OCO Source Materials
 * IBM Concerto - Blockchain Solution Framework
 * Copyright IBM Corp. 2016
 * The source code for this program is not published or otherwise
 * divested of its trade secrets, irrespective of what has
 * been deposited with the U.S. Copyright Office.
 */

'use strict';

const AccessController = require('./accesscontroller');
const Api = require('./api');
const BusinessNetworkDefinition = require('@ibm/concerto-common').BusinessNetworkDefinition;
const IdentityManager = require('./identitymanager');
const JSTransactionExecutor = require('./jstransactionexecutor');
const Logger = require('@ibm/concerto-common').Logger;
const LRU = require('lru-cache');
const QueryExecutor = require('./queryexecutor');
const RegistryManager = require('./registrymanager');
const Resolver = require('./resolver');
const TransactionLogger = require('./transactionlogger');

const LOG = Logger.getLog('Context');

const businessNetworkCache = LRU(8);

/**
 * A class representing the current request being handled by the JavaScript engine.
 * @protected
 * @abstract
 * @memberof module:ibm-concerto-runtime
 */
class Context {

    /**
     * Store a business network in the cache.
     * @param {string} businessNetworkHash The hash of the business network definition.
     * @param {BusinessNetworkDefinition} businessNetworkDefinition The business network definition.
     */
    static cacheBusinessNetwork(businessNetworkHash, businessNetworkDefinition) {
        const method = 'cacheBusinessNetwork';
        LOG.entry(method, businessNetworkHash, businessNetworkDefinition);
        businessNetworkCache.set(businessNetworkHash, businessNetworkDefinition);
        LOG.exit(method);
    }

    /**
     * Constructor.
     * @param {Engine} engine The chaincode engine that owns this context.
     */
    constructor(engine) {
        this.engine = engine;
        this.businessNetworkDefinition = null;
        this.registryManager = null;
        this.resolver = null;
        this.api = null;
        this.queryExecutor = null;
        this.identityManager = null;
        this.participant = null;
        this.transaction = null;
        this.transactionExecutors = [];
        this.accessController = null;
    }

    /**
     * Initialize the context for use.
     * @return {Promise} A promise that will be resolved when complete, or rejected
     * with an error.
     */
    initialize() {
        const method = 'initialize';
        LOG.entry(method);

        // Load the business network from the archive.
        LOG.debug(method, 'Getting $sysdata collection');
        return this.getDataService().getCollection('$sysdata')
            .then((collection) => {
                LOG.debug(method, 'Getting business network archive from the $sysdata collection');
                return collection.get('businessnetwork');
            })
            .then((object) => {
                LOG.debug(method, 'Looking in cache for business network', object.hash);
                let businessNetworkDefinition = businessNetworkCache.get(object.hash);
                if (businessNetworkDefinition) {
                    LOG.debug(method, 'Business network is in cache');
                    return businessNetworkDefinition;
                }
                LOG.debug(method, 'Business network is not in cache, loading');
                let businessNetworkArchive = Buffer.from(object.data, 'base64');
                return BusinessNetworkDefinition.fromArchive(businessNetworkArchive)
                    .then((businessNetworkDefinition) => {
                        Context.cacheBusinessNetwork(object.hash, businessNetworkDefinition);
                        return businessNetworkDefinition;
                    });
            })
            .then((businessNetworkDefinition) => {
                LOG.debug(method, 'Loaded business network archive');
                this.businessNetworkDefinition = businessNetworkDefinition;
                let currentUserID = this.getIdentityService().getCurrentUserID();
                LOG.debug(method, 'Got current user ID', currentUserID);
                if (currentUserID) {
                    return this.getIdentityManager().getParticipant(currentUserID)
                        .then((participant) => {
                            LOG.debug(method, 'Found current participant', participant.getFullyQualifiedIdentifier());
                            this.setParticipant(participant);
                        })
                        .catch((error) => {
                            LOG.error(method, 'Could not find current participant', error);
                            throw new Error(`Could not determine the participant for identity '${currentUserID}'. The identity may be invalid or may have been revoked.`);
                        });
                } else {
                    // TODO: this is temporary whilst we migrate to requiring all
                    // users to have identities that are mapped to participants.
                    LOG.debug(method, 'Could not determine current user ID');
                }
            })
            .then(() => {
                LOG.debug(method, 'Installing default JavaScript transaction executor');
                this.addTransactionExecutor(new JSTransactionExecutor());
            })
            .then(() => {
                LOG.exit(method);
            });

    }

    /**
     * Get the data service provided by the chaincode container.
     * @abstract
     * @return {DataService} The data service provided by the chaincode container.
     */
    getDataService() {
        throw new Error('abstract function called');
    }

    /**
     * Get the identity service provided by the chaincode container.
     * @abstract
     * @return {IdentityService} The identity service provided by the chaincode container.
     */
    getIdentityService() {
        throw new Error('abstract function called');
    }

    /**
     * Get the model manager.
     * @return {ModelManager} The model manager.
     */
    getModelManager() {
        if (!this.businessNetworkDefinition) {
            throw new Error('must call initialize before calling this function');
        }
        return this.businessNetworkDefinition.getModelManager();
    }

    /**
     * Get the script manager.
     * @return {ScriptManager} The script manager.
     */
    getScriptManager() {
        if (!this.businessNetworkDefinition) {
            throw new Error('must call initialize before calling this function');
        }
        return this.businessNetworkDefinition.getScriptManager();
    }

    /**
     * Get the ACL manager.
     * @return {AclManager} The ACL manager.
     */
    getAclManager() {
        if (!this.businessNetworkDefinition) {
            throw new Error('must call initialize before calling this function');
        }
        return this.businessNetworkDefinition.getAclManager();
    }

    /**
     * Get the factory.
     * @return {Factory} The factory.
     */
    getFactory() {
        if (!this.businessNetworkDefinition) {
            throw new Error('must call initialize before calling this function');
        }
        return this.businessNetworkDefinition.getFactory();
    }

    /**
     * Get the serializer.
     * @return {Serializer} The serializer.
     */
    getSerializer() {
        if (!this.businessNetworkDefinition) {
            throw new Error('must call initialize before calling this function');
        }
        return this.businessNetworkDefinition.getSerializer();
    }

    /**
     * Get the introspector.
     * @return {Introspector} The serializer.
     */
    getIntrospector() {
        if (!this.businessNetworkDefinition) {
            throw new Error('must call initialize before calling this function');
        }
        return this.businessNetworkDefinition.getIntrospector();
    }

    /**
     * Get the registry manager.
     * @return {RegistryManager} The registry manager.
     */
    getRegistryManager() {
        if (!this.registryManager) {
            this.registryManager = new RegistryManager(this.getDataService(), this.getIntrospector(), this.getSerializer(), this.getAccessController());
        }
        return this.registryManager;
    }

    /**
     * Get the resolver.
     * @return {Resolver} The resolver.
     */
    getResolver() {
        if (!this.resolver) {
            this.resolver = new Resolver(this.getIntrospector(), this.getRegistryManager());
        }
        return this.resolver;
    }

    /**
     * Get the API.
     * @return {Api} The API.
     */
    getApi() {
        if (!this.api) {
            this.api = new Api(this.getFactory(), this.getParticipant(), this.getRegistryManager());
        }
        return this.api;
    }

    /**
     * Get the query executor.
     * @return {QueryExecutor} The query executor.
     */
    getQueryExecutor() {
        if (!this.queryExecutor) {
            this.queryExecutor = new QueryExecutor(this.getResolver());
        }
        return this.queryExecutor;
    }

    /**
     * Get the identity manager.
     * @return {IdentityManager} The identity manager.
     */
    getIdentityManager() {
        if (!this.identityManager) {
            this.identityManager = new IdentityManager(this.getDataService(), this.getRegistryManager());
        }
        return this.identityManager;
    }

    /**
     * Get the current participant.
     * @return {Resource} the current participant.
     */
    getParticipant() {
        return this.participant;
    }

    /**
     * Set the current participant.
     * @param {Resource} participant the current participant.
     */
    setParticipant(participant) {
        if (this.participant) {
            throw new Error('A current participant has already been specified');
        }
        this.participant = participant;
        this.getAccessController().setParticipant(participant);
    }

    /**
     * Get the current transaction.
     * @return {Resource} the current transaction.
     */
    getTransaction() {
        return this.transaction;
    }

    /**
     * Set the current transaction.
     * @param {Resource} transaction the current transaction.
     */
    setTransaction(transaction) {
        if (this.transaction) {
            throw new Error('A current transaction has already been specified');
        }
        this.transaction = transaction;
        this.transactionLogger = new TransactionLogger(this.transaction, this.getRegistryManager(), this.getSerializer());
    }

    /**
     * Add a transaction executor.
     * @param {TransactionExecutor} transactionExecutor The transaction executor.
     */
    addTransactionExecutor(transactionExecutor) {
        const method = 'addTransactionExecutor';
        LOG.entry(method, transactionExecutor);
        let replaced = this.transactionExecutors.some((existingTransactionExecutor, index) => {
            if (transactionExecutor.getType() === existingTransactionExecutor.getType()) {
                LOG.debug(method, 'Found existing executor for type, replacing', transactionExecutor.getType());
                this.transactionExecutors[index] = transactionExecutor;
                return true;
            } else {
                return false;
            }
        });
        if (!replaced) {
            LOG.debug(method, 'Did not replace executor, adding to end of list', transactionExecutor.getType());
            this.transactionExecutors.push(transactionExecutor);
        }
        LOG.exit(method);
    }

    /**
     * Get the list of transaction executors.
     * @return {TransactionExecutor[]} The list of transaction executors.
     */
    getTransactionExecutors() {
        return this.transactionExecutors;
    }

    /**
     * Get the access controller.
     * @return {AccessController} The access controller.
     */
    getAccessController() {
        if (!this.accessController) {
            this.accessController = new AccessController(this.getAclManager());
        }
        return this.accessController;
    }

    /**
     * Stop serialization of this object.
     * @return {Object} An empty object.
     */
    toJSON() {
        return {};
    }

}

module.exports = Context;