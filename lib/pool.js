var events = require('events');
var async = require('async');
var ethaddress = require('ethereum-address');
var bignum = require('bignum');

var varDiff = require('./varDiff.js');
var daemon = require('./daemon.js');
var peer = require('./peer.js');
var stratum = require('./stratum.js');
var jobManager = require('./jobManager.js');
var util = require('./util.js');

/*process.on('uncaughtException', function(err) {
 console.log(err.stack);
 throw err;
 });*/

var pool = module.exports = function pool(options, authorizeFn) {

    this.options = options;

    var _this = this;
    var blockPollingIntervalId;


    var emitLog = function (text) {
        _this.emit('log', 'debug', text);
    };
    var emitWarningLog = function (text) {
        _this.emit('log', 'warning', text);
    };
    var emitErrorLog = function (text) {
        _this.emit('log', 'error', text);
    };
    var emitSpecialLog = function (text) {
        _this.emit('log', 'special', text);
    };


    if (!(options.coin.algorithm in algos)) {
        emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
        throw new Error();
    }


    this.start = function () {
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterface(function () {
            DetectCoinData(function () {
                SetupRecipients();
                SetupJobManager();
                OnBlockchainSynced(function () {
                    GetFirstJob(function () {
                        SetupBlockPolling();
                        SetupPeer();
                        StartStratumServer(function () {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };


    function GetFirstJob(finishedCallback) {

        GetWork(function (error, result) {
            if (error) {
                emitErrorLog('Error with eth_getWork on creating first job, server cannot start');
                return;
            }

            var portWarnings = [];

            var networkDiffAdjusted = options.initStats.difficulty;

            Object.keys(options.ports).forEach(function (port) {
                var portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });

            //Only let the first fork show synced status or the log wil look flooded with it
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                var warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                emitWarningLog(warnMessage);
            }

            finishedCallback();
        });
    }


    function OutputPoolInfo() {

        var startMessage = 'Stratum Pool Server Started for ' + options.coin.name +
            ' [' + options.coin.symbol.toUpperCase() + '] {' + options.coin.algorithm + '}';
        if (process.env.forkId && process.env.forkId !== '0') {
            emitLog(startMessage);
            return;
        }
        var infoLines = [startMessage,
            'Network Connected:\t' + options.chain,
            'Current Block Height:\t' + options.height,
            'Current Block Diff:\t' + options.difficulty,
            'Current Active Peers:\t' + options.peers.active,
            'Current Connected Peers:\t' + options.peers.connected,
            'Max Peers:\t' + options.peers.max,
            'Total Difficulty:\t' + options.initStats.totalDifficulty,
            'Network Hash Rate:\t' + util.getReadableHashRateString(options.difficulty/25),
            'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', '),
            'Pool Fee Percent:\t' + _this.options.feePercent + '%'
        ];

        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' ms');

        emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }


    function OnBlockchainSynced(syncedCallback) { // Функция проверяет, синхронизирована ли нода с блокчейном.

        var checkSynced = function (displayNotSynced) {
            _this.daemon.cmd('eth_syncing', [], function (results) {
                var synced = results.every(function (r) {
                    return !r.response;
                });
                if (synced) {
                    syncedCallback();
                }
                else {
                    if (displayNotSynced) displayNotSynced();
                    setTimeout(checkSynced, 5000);

                    //Only let the first fork show synced status or the log wil look flooded with it
                    if (!process.env.forkId || process.env.forkId === '0') 
                        generateProgress();
                }

            });
        };
        checkSynced(function () {
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });


        var generateProgress = function () {

            _this.daemon.cmd('eth_syncing', [], function (results) {
                var daemon = results.sort(function (a, b) {
                    return b.response.currentBlock - a.response.currentBlock;
                })[0].response;

                var blockCount = daemon.currentBlock;
                var totalBlocks = daemon.highestBlock;

                //get list of peers and their highest block height to compare to ours
                _this.daemon.cmd('parity_netPeers', [], function (results) {

                    var peers = results[0].response.connected;

                    var percent = (blockCount / totalBlocks * 100).toFixed(2);
                    emitWarningLog('Downloaded '+blockCount+'/'+totalBlocks+' ('+percent+'%) of blockchain from '+peers+' peers');
                });

            });
        };

    }


    function SetupApi() { // Бесполезная хуита. Ни в README, ни в каких-либо других файлах это не используется.
        if (typeof(options.api) !== 'object' || typeof(options.api.start) !== 'function') {
        } else {
            options.api.start(_this);
        }
    }


    function SetupPeer() {
        if (!options.p2p || !options.p2p.enabled)
            return;

        if (options.testnet && !options.coin.peerMagicTestnet) {
            emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        }
        else if (!options.coin.peerMagic) {
            emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        _this.peer = new peer(options);
        _this.peer.on('connected', function () {
            emitLog('p2p connection successful');
        }).on('connectionRejected', function () {
            emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', function () {
            emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function (e) {
            emitErrorLog('p2p connection failed - likely incorrect host or port');
        }).on('socketError', function (e) {
            emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', function (msg) {
            emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', function (hash) {
            _this.processBlockNotify(hash, 'p2p');
        });
    }

    /*В этой функции мы будем для портов из config-а вызывать функцию setVarDiff для генерации сложности для каждого подключившегося 
    майнера. */
    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function (port) { // Начинаем перебирать порты
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }


    /*
     Coin daemons either use submitblock or getblocktemplate for submitting new blocks
     */
    function SubmitBlock(data, callback) {

        var rpcCommand, rpcArgs;
        if (options.hasSubmitMethod) {
            rpcCommand = 'eth_submitWork';
            rpcArgs = data;
        }
        else {
            emitErrorLog('SUBMIT METHOD HAS NOT FOUND!!!');
        }


        _this.daemon.cmd(rpcCommand,
            rpcArgs,
            function (result) {
                if (result.error) {
                    emitErrorLog('rpc error with daemon instance ' +
                        result.instance.index + ' when submitting block with ' + rpcCommand + ' ' +
                        JSON.stringify(result.error)
                    );
                    return;
                }
                if(!result.response){
                    emitErrorLog('Daemon instance ' + result.instance + ' rejected a supposedly valid block');
                    return;
                }
                emitLog('Submitted Block using ' + rpcCommand + ' successfully to daemon instance(s)');
                callback();
            },
            true
        );
    }

    function SetupRecipients() { // Функция, чтобы записать в options массив структур данных {адрес получателя, вознаграждение}, а так же 
        // общую сумму всех вознаграждений
        var recipients = [];
        options.feePercent = 0; // Процентная ставка, общая сумма всех вознаграждений получателям
        options.rewardRecipients = options.rewardRecipients || {}; // Вознаграждения получателям

        for (var r in options.rewardRecipients) { // Идем по получателям
            var percent = options.rewardRecipients[r]; // Записываем в переменную вознаграждение очередного получателя
            var rObj = {
                percent: percent, // Процент получателя
                address: r // Адрес получателя
            };
                recipients.push(rObj); // Добавляем структуру в массивчик
                options.feePercent += percent; // Суммируем вознаграждения
        }

        if (recipients.length === 0) { 
            emitErrorLog('No rewardRecipients have been setup which means no fees will be taken');
        }
        options.recipients = recipients; // Записываем в options структуру из адресов получателей и их вознаграждений
    }

    var jobManagerLastSubmitBlockHex = false;

    function SetupJobManager() { // Инициализирует экземпляр класса jobManager, методы которого служат для запуска обработки новой шары, блока
        // и обновления блока.

        _this.jobManager = new jobManager(options); // Создаем экземпляр класса jobmanager, передавая в качестве аргумента config (options)

        _this.jobManager.on('newBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                var job = blockTemplate.getJobParams();
                job[8] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function (isValid, shareData) {
            var isValidBlock = isValid.block;
            var emitShare = function () {
                _this.emit('share', isValid.share, isValidBlock, shareData);
            };
            var submitWork = [
                shareData.header,
                shareData.nonce,
                shareData.mixDigest
            ];

            /*
             If we calculated that the block solution was found,
             before we emit the share, lets submit the block,
             then check if it was accepted using RPC getblock
             */
            if (!isValidBlock)
                emitShare();
            else {
                if (jobManagerLastSubmitBlockHex === shareData.header) {
                    emitWarningLog('Warning, ignored duplicate submit block ' + shareData.header);
                } else {
                    jobManagerLastSubmitBlockHex = shareData.header;
                    SubmitBlock(submitWork, function () {
                        CheckBlockAccepted(shareData.header, function (isAccepted, address) {
                            isValidBlock = isAccepted === true;
                            if (isValidBlock === true) {
                                emitLog('Block reward has been sent to '+ address);
                            } else {
                                emitErrorLog('Valid block rejected! '+ address);
                            }
                            emitShare();
                            GetWork(function (error, result, foundNewBlock) {
                                if (foundNewBlock) {
                                    emitLog('Block notification via RPC after block submission');
                                }
                            });
                        });
                    });
                }
            }
        }).on('log', function (severity, message) {
            _this.emit('log', severity, message);
        });
    }


    function SetupDaemonInterface(finishedCallback) {

        if (!Array.isArray(options.daemons) || options.daemons.length < 1) { // Проверяем, есть ли в config-файле демоны
            emitErrorLog('No daemons have been configured - pool cannot start'); // И если нет, то выводим сообщение об ошибке
        }

        _this.daemon = new daemon.interface(options.daemons, function (severity, message) { /* Используем конструктор нового экземпляра класса 
            DaemonInterface (см. файл daemon.js), который экспортируется сюда под именем interface. Первый аргумент функции-конструктора - это 
            часть config-файла о демонах, второй аргумент - это callback функция, которая будет интерпретироваться как аргумент logger функции 
            DaemonInterface. Т.е. каждый раз, когда функция logger встречается внутри DaemonInterface, выполняется данная функция. */
            _this.emit('log', severity, message); // Генерируется сигнал 'log' с аргументами, которые указаны в функции logger, и который
            // посылается на обработку (а конкретнее в функции-обработчики z-nomp).
        });

        _this.daemon.once('online', function () { // Функция .once == .on, различие в том, что регестрируется сигнал только 1 раз.
            // emit данного сигнала находится в функции init() в файле daemon.js
            finishedCallback(); // Выполняется функция finishedCallback(), которая одновременно является и аргументом функции
            // SetupDaemonInterface. В нашем случае аргументом функции SetupDaemonInterface является функция DetectCoinData, которая в свою
            // очередь принимается в качестве callback-a другие функции (т.е. функции пула работают по принципу callback в callback и.т.д.)

        }).on('connectionFailed', function (error) {
            emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));

        }).on('error', function (message) {
            emitErrorLog(message);

        });

        _this.daemon.init(); // Начинаем работу. Вызываем функцию инициализации нового демона, см. в файле deamon.js
    }


    function DetectCoinData(finishedCallback) { // Данная функция предназначена для того, чтобы запросить и записать в options данные по
        // валюте которую мы будем майнить

        var batchRpcCalls = [ // Партия RPC-запросов в виде массива.
            ['parity_chain', []],
            ['parity_netPeers', []],
            ['eth_submitWork', []],
            ['eth_getBlockByNumber', ["pending", false]]
        ];

        _this.daemon.batchCmd(batchRpcCalls, function (error, results) { // Начинаем выполнять функцию batchCmd из файла daemon.js
            if (error || !results) {
                emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
                return;
            }

            var rpcResults = {};

            for (var i = 0; i < results.length; i++) { // Для каждого элемента из присланного от HTTP-клиента массива JSON данных (results)
                var rpcCall = batchRpcCalls[i][0]; // В переменную rpcCall записываем тип запроса из партии batchRpcCalls
                var r = results[i]; // В переменную r записываем очередной элемент массива JSON данных от HTTP-клиента.
                rpcResults[rpcCall] = r.result || r.error; // В ассоциативный массив записываем либо данные, либо ошибку

                if (rpcCall !== 'eth_submitWork' && (r.error || !r.result)) { // По данной логика, для 'eth_submitWork' не присылаются ни
                    // JSON данные, ни ошибки.
                    emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }
            
            if (!ethaddress.isAddress(options.address)) {
                emitErrorLog('This address is not valid');
                return;
            }

            options.coin.reward = 'POW';
            // Make check coin reward (PoW/PoS)


            /* POS coins must use the pubkey in coinbase transaction, and pubkey is
              only given if address is owned by wallet.*/
            // if (options.coin.reward === 'POS' && typeof(rpcResults.validateaddress.pubkey) === 'undefined') {
            //     emitErrorLog('The address provided is not from the daemon wallet - this is required for POS coins.');
            //     return;
            // }
            
            // Заполняем поля options данными, пришедшими по RPC-запросам.
            options.chain = rpcResults.parity_chain;

            options.peers = {
                active: rpcResults.parity_netPeers.active,
                connected: rpcResults.parity_netPeers.connected,
                max: rpcResults.parity_netPeers.max
            };
            
            options.height = bignum(rpcResults.eth_getBlockByNumber.number, 16);
            options.difficulty = bignum(rpcResults.eth_getBlockByNumber.difficulty.slice(2), 16);
            options.totalDifficulty = bignum(rpcResults.eth_getBlockByNumber.totalDifficulty, 16);
            console.log(options.difficulty);

            if (rpcResults.eth_submitWork.message === 'Method not found') {
                options.hasSubmitMethod = false;
            }
            else if (rpcResults.eth_submitWork.code === -32602) {
                options.hasSubmitMethod = true;
            }
            else {
                emitErrorLog('Could not detect block submission RPC method, ' + JSON.stringify(results));
                return;
            }

            finishedCallback();

        });
    }


    function StartStratumServer(finishedCallback) { // Запускаем стратум-сервер.
        _this.stratumServer = new stratum.Server(options, authorizeFn); // Инициализируем обьект класса stratumServer. В аргументах передается
        // config и функция авторизации.

        _this.stratumServer.on('started', function () {
            options.initStats.stratumPorts = Object.keys(options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();

        }).on('broadcastTimeout', function () {
            emitLog('No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');

            GetWork(function (error, rpcData, processedBlock) {
                if (error || processedBlock) return;
                _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', function (client) { // Функция регает нового клиента, и запускает функцию manageClient, которая находится
            // внутри функции varDiff (см. файл varDiff.js) и генерит сигнал 'newDifficulty', в результате чего генерится сложность для 
            //нового пользователя и данного порта.
            if (typeof(_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', function (diff) { // Ловим сигнал 'difficultyChanged' и генерим 'difficultyUpdate'.
                _this.emit('difficultyUpdate', client.workerName, diff); 

            }).on('subscription', function (params, resultCallback) {

                var extraNonce = _this.jobManager.extraNonceCounter.next();
                resultCallback(null,
                    extraNonce
                );

                // if (typeof(options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                //     this.sendDifficulty(options.ports[client.socket.localPort].diff);
                // } else {
                //     this.sendDifficulty(8);
                // }

                var jobParams = _this.jobManager.currentJob.getJobParams();
                jobParams[2] = util.calcDifficulty(options.ports[client.socket.localPort].diff);
                this.sendMiningJob(jobParams);

            }).on('submit', function (params, resultCallback) {
                _this.jobManager.processShare(
                    params.worker,
                    params.jobId,
                    params.nonce,
                    params.header,
                    params.mix,
                    params.difficulty,
                    client.remoteAddress,
                    client.socket.localPort,
                    function(result){
                        resultCallback(result.error, result.share ? true : null);
                    }
                );

            }).on('malformedMessage', function (message) {
                emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);

            }).on('socketError', function (err) {
                emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));

            }).on('socketTimeout', function (reason) {
                emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason)

            }).on('socketDisconnect', function () {
                //emitLog('Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', function (remainingBanTime) {
                emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function () {
                emitLog('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function (fullMessage) {
                emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function () {
                emitWarningLog('Detected socket flooding from ' + client.getLabel());

            }).on('tcpProxyError', function (data) {
                emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);

            }).on('bootedBannedWorker', function () {
                emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');

            }).on('triggerBan', function (reason) {
                emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }


    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
            emitLog('Block template polling has been disabled');
            return;
        }

        var pollingInterval = options.blockRefreshInterval;

        blockPollingIntervalId = setInterval(function () {
            GetWork(function (error, result, foundNewBlock) {
                if (foundNewBlock)
                    emitLog('Block notification via RPC polling');
            });
        }, pollingInterval);
    }


    function GetWork(callback) {
        function getBlockTemplate(callback) {
            _this.daemon.cmd('eth_getBlockByNumber',
                ["pending", true],
                function (result) {
                    if (result.error) {
                        emitErrorLog('eth_getBlockByNumber call failed for daemon instance ' +
                            result.instance.index + ' with error ' + JSON.stringify(result.error));
                        callback(result.error);
                    } else {
                        callback = function (blockTemplate) { getWork(blockTemplate) };
                        var blockTemplate = result.response; // blockTemplate - это текущий блок
                        callback(blockTemplate); 
                    }
                }, true 
            );
        }


        function getWork(blockTemplate) {

            _this.daemon.cmd('eth_getWork',
                [],
                function (result) {
                    if (result.error) {
                        emitErrorLog('eth_getWork call failed for daemon instance ' +
                            result.instance.index + ' with error ' + JSON.stringify(result.error));
                        callback(result.error);
                    } else {
                        var response = {};
                        response.header = result.response[0];
                        response.seed = result.response[1];
                        response.target = result.response[2];
                        response.rpc = blockTemplate;
                        response.height = bignum(blockTemplate.number, 16);
                        response.difficulty = bignum(blockTemplate.difficulty, 16);

                        var processedNewBlock = _this.jobManager.processTemplate(response);
                        callback(null, result.response, processedNewBlock);
                        callback = function () {
                        };
                    }
                }, true
            );
        }

        getBlockTemplate();
    }


    function CheckBlockAccepted(blockHash, callback) {
        //setTimeout(function(){
        _this.daemon.cmd('eth_getBlockByHash',
            [blockHash, false],
            function (results) {
                var validResults = results.filter(function (result) {
                    return result.response && (result.response.hash === blockHash)
                });
                // do we have any results?
                if (validResults.length >= 1) {
                    // check for invalid blocks with negative confirmations
                    if (validResults[0].response.miner == options.address) {
                        // accepted valid block!
                        callback(true, validResults[0].response.tx[0]);
                    } else {
                        // reject invalid block
                        callback(false);
                    }
                    return;
                }
                // invalid block, rejected
                callback(false, "Check coin daemon logs!");
            }
        );
    }


    /**
     * This method is being called from the blockNotify so that when a new block is discovered by the daemon
     * We can inform our miners about the newly found block
     **/
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        emitLog('Block notification via ' + sourceTrigger);
        if (typeof(_this.jobManager) !== 'undefined' && typeof(_this.jobManager.currentJob) !== 'undefined' && typeof(_this.jobManager.currentJob.rpcData.previousblockhash) !== 'undefined' && blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash) {
            GetWork(function (error, result) {
                if (error)
                    emitErrorLog('Block notify error getting block template for ' + options.coin.name);
            })
        }
    };


    this.relinquishMiners = function (filterFn, resultCback) {
        var origStratumClients = this.stratumServer.getStratumClients();

        var stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({subId: subId, client: origStratumClients[subId]});
        });
        async.filter(
            stratumClients,
            filterFn,
            function (clientsToRelinquish) {
                clientsToRelinquish.forEach(function (cObj) {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(function () {
                    resultCback(
                        clientsToRelinquish.map(
                            function (item) {
                                return item.client;
                            }
                        )
                    );
                });
            }
        )
    };


    this.attachMiners = function (miners) {
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    this.getStratumServer = function () {
        return _this.stratumServer;
    };

    /* Эта функция, выполняемая внутри функции SetupVarDiff, должна сгенерировать для присоединившегося майнера сложность вычислений 
    при помощи функции varDiff() из библиотеки varDiff, и записать её в ассоциативный массив _this.varDiff[port] по
    номеру порта подключения. В ходе выполнения функции varDiff (описание функции см. в файле varDiff.js) генерируется сигнал 'newDifficulty'.
    Этот сигнал будет зарегестрирован при помощи функции .on('newDifficulty', ... ), в результате чего начнется её выполнение (т.е. функция 
    _this.varDiff[port].on('newDifficulty', function (client, newDiff) {} будет выполнятся только тогда, когда будет сгенерен сигнал 
    'newDifficulty'). В результате этого запустится функция enqueueNextDifficulty, которая передаст сложность в качестве аргумента в протокол 
    Stratum. (см. файл Stratum.js)*/
    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof(_this.varDiff[port]) !== 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        _this.varDiff[port] = new varDiff(port, varDiffConfig);
        _this.varDiff[port].on('newDifficulty', function (client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

            /*if (options.varDiff.mode === 'fast'){
             //Send new difficulty, then force miner to use new diff by resending the
             //current job parameters but with the "clean jobs" flag set to false
             //so the miner doesn't restart work and submit duplicate shares
             client.sendDifficulty(newDiff);
             var job = _this.jobManager.currentJob.getJobParams();
             job[8] = false;
             client.sendMiningJob(job);
             }*/

        });
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;
