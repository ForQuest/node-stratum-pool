var BigNum = require('bignum');
var net = require('net');
var events = require('events');
var tls = require('tls');
var fs = require('fs');

var util = require('./util.js');

var TLSoptions;

var SubscriptionCounter = function(){
    var count = 0;
    var padding = 'deadbeefcafebabe'; // выебываешься
    return {
        next: function(){
            count++;
            if (Number.MAX_VALUE === count) count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};


/**
 * Defining each client that connects to the stratum server.
 * Emits:
 *  - subscription(obj, cback(error, extraNonce, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
**/
var StratumClient = function(options){
    var pendingDifficulty = null;
    //private members
    this.subscriptionId = options.subscriptionId;
    this.socket = options.socket;
    this.remoteAddress = options.socket.remoteAddress;
    var banning = options.banning;
    var _this = this;
    this.lastActivity = Date.now(); // Последняя активность
    this.shares = {valid: 0, invalid: 0};


    var considerBan = (!banning || !banning.enabled) ? function(){ return false } : function(shareValid){ // Если banning не доступен, тогда
        // вернет false. Если доступен, то выполняем функию.
        if (shareValid === true) _this.shares.valid++; // если шара валидна, инкрементируем valid
        else _this.shares.invalid++; // если нет, то инкрементируем invalid
        var totalShares = _this.shares.valid + _this.shares.invalid; // общее количество шар
        if (totalShares >= banning.checkThreshold){ // если общее количество шар достигло отметки, при которой необходимо провести проверку 
            var percentBad = (_this.shares.invalid / totalShares) * 100; // находим процент не валидных шар
            if (percentBad < banning.invalidPercent) // если процент не превышает заданное пороговое значение
                this.shares = {valid: 0, invalid: 0}; // обнуляем статистики
            else { // если все-таки превышает, то разрываем соединение с клиентом
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid'); // высылаем 
                // сообщение о бане
                _this.socket.destroy(); // разрываем socket-соединение с клиентом
                return true;
            }
        }
        return false;
    };

    this.init = function init(){ // ЗАпускаем инициализацию клиента
        setupSocket();
    };

    function handleMessage(message){ // Функция, которая указывает, что делать в ответ на различные типы приходящих от пользователя сообщений.
        switch(message.method){
            case 'mining.subscribe': // Майнер уведомляет сервер о подключении
                handleSubscribe(message);
                break;
            case 'mining.authorize': // Майнер авторизируется на сервере
                handleAuthorize(message);
                break;
            case 'mining.submit': // Майнер отправляет пулу выполненную работу для подтверждения
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.get_transactions': // Майнер запрашивает транзакции для работы
                            sendJson({ // Пул посылает майнера нахуй (с ошибкой)
                    id     : null,
                    result : [],
                    error  : true
                });
                break;
            case 'mining.extranonce.subscribe': // Майнер уведомляет пул, что готов к изменению extranonce
                sendJson({
                    id: message.id,
                    result: false,
                    error: [20, "Not supported.", null]
                });
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }

    function handleSubscribe(message){
        if (!_this.authorized) { // Если клиент не авторизован
            _this.requestedSubscriptionBeforeAuth = true;
        }

        _this.emit('subscription', 
            {}, // второй аргумент ??????
            function(error, extraNonce){
                if (error){ // Если возникла ошибка, возвращаем обратно id сообщения с непосредственно самой ошибкой
                    sendJson({
                        id: message.id,
                        result: null,
                        error: error
                    });
                    return;
                }
                _this.extraNonce = extraNonce;

                sendJson({ // Если все нормально, пул высылает майнеру extranonce1
                    id: message.id,
                    result: [
                        [["mining.set_difficulty", _this.subscriptionId],["mining.notify",_this.subscriptionId]], //sessionId
                        extraNonce,
                        4
                    ],
                    error: null
                });
            });
    }

    function handleAuthorize(message){
        _this.workerName = message.params[0]; // Принимаем логин и пароль
        _this.workerPass = message.params[1];

        options.authorizeFn(_this.remoteAddress, options.socket.localPort, _this.workerName, _this.workerPass, function(result) {
            // Вызываем функцию authoruzeFn из z-nomp. С помощью этой функции происходит непосредственно сама авторизация
            _this.authorized = (!result.error && result.authorized); // если без ошибок, вернет true

            sendJson({
                id     : message.id,
                result : _this.authorized,
                error  : result.error
            });

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                options.socket.destroy();
            }
        });
    }

    function handleSubmit(message){ // Пулу на подтверждение приходит шара
        if (_this.authorized === false){ // Проверяем, авторизован ли пользователь
            sendJson({
                id    : message.id,
                result: null,
                error : [24, "unauthorized worker", null]
            });
            considerBan(false);
            return;
        }
        if (!_this.extraNonce){ // Для данного пользователя отсутствует extranonce1. Проверка невозможна.
            sendJson({ 
                id    : message.id,
                result: null,
                error : [25, "not subscribed", null]
            });
            considerBan(false);
            return;
        }
        _this.emit('submit', 
            {
                name      : message.params[0],
                jobId     : message.params[1],
                nonce     : message.params[2], // extranonce + miningmonce
                header    : message.params[3], // транзакции, информация и пр.
                mix       : message.params[4], // получившийся результат
                difficulty: _this.difficulty
                // вся эта структура отправляется прямиком на верификацию (processShare)
            },
            // lie to Claymore miner due to unauthorized devfee submissions
            function(error, result){ // Возращает результат: валидная ли шара
                if (!considerBan(result)){
                    sendJson({ // отправляем майнеру сообщение, что шара валидна
                        id: message.id,
                        result: true,
                        error: null
                    });
                }
            }
        );

    }

    function sendJson(){ // Отправить JSON данные клиенту
        var response = '';
        for (var i = 0; i < arguments.length; i++){
            response += JSON.stringify(arguments[i]) + '\n';
        }
        options.socket.write(response);
    }

    function setupSocket(){ // Функция, устанавливающая socket-соединение с клиентом
        var socket = options.socket;
        var dataBuffer = '';
        socket.setEncoding('utf8');

        if (options.tcpProxyProtocol === true) {
            socket.once('data', function (d) { // Один раз регестрирует сигнал
                if (d.indexOf('PROXY') === 0) { // если в массиве данных d индекс элемента 'PROXY' = 0
                    _this.remoteAddress = d.split(' ')[2]; // Функция split разбивает присланные данные (в данном случае данные в d содержатся
                    // в формате String) на массив строк путём разделения строки пробелом. Второй кусок данных будет IP адресом клиента.
                }
                else{
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        }
        else{
            _this.emit('checkBan');
        }
        socket.on('data', function(d){ // Функция, которая начинает выполняться, когда от майнера приходят данные.
            dataBuffer += d; // Буфер данных, принимающий все, что нам приходит.
            if (new Buffer.byteLength(dataBuffer, 'utf8') > 10240){ // Если буфер разрастается аж на 10KB, то что-то не так, и, видимо, на пул
                // совершается атака.
                dataBuffer = ''; // Поэтому мы обнуляем буфер.
                _this.emit('socketFlooded'); // Запускаем emit, что в сокет флудят.
                socket.destroy(); // И разрушаем соединение.
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1){ // Если в dataBuffer что-то есть
                var messages = dataBuffer.split('\n'); // Разделяем dataBuffer построчно
                var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop(); // Незаконченное сообщение (если есть) удаляем их массива
                // и записываем в incomplite
                messages.forEach(function(message){ // Для каждого присланного сообщения
                    if (message.length < 1) return; // сообщений нет
                    var messageJson;
                    try {
                        messageJson = JSON.parse(message); // Парсим сообщение
                    } catch(e) { // Если при этом возникает ошибочка, выводим в лог и делаем соответствующий emit
                        if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0){
                            _this.emit('malformedMessage', message);
                            socket.destroy(); // разрушаем соединение
                        }

                        return;
                    }
                    if (messageJson) { // если все прошло нормально
                        handleMessage(messageJson); // запускаем функцию-парсер сообщений
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function() { 
            _this.emit('socketDisconnect');
        });
        socket.on('error', function(err){
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }


    this.getLabel = function(){
        return (_this.workerName || '(unauthorized)') + ' [' + _this.remoteAddress + ']'; // Функция возвращает имя клиента и его IP адрес.
    };

    this.enqueueNextDifficulty = function(requestedNewDifficulty) { // обновляем сложность (для varDiff)
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    //public members

    /**
     * IF the given difficulty is valid and new it'll send it to the client.
     * returns boolean
     **/
    this.sendDifficulty = function(difficulty){ // Передаем майнеру новый difficulty
        if (difficulty === this.difficulty) // Нет смысла обновлять, новый и старый совпадают
            return false;
        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;

        //powLimit * difficulty
        var powLimit = algos.equihash.diff; // TODO: Get algos object from argument
        var adjPow = powLimit / difficulty;
        if ((64 - adjPow.toString(16).length) === 0) { // если длина высчитанного значения в 16-ой системе счисления == 64
            var zeroPad = '';
        }
        else {
            var zeroPad = '0';
            zeroPad = zeroPad.repeat((64 - (adjPow.toString(16).length))); // функция repeat вернет строку, содержащую указанное в аргументе
            // количество соединённых вместе копий строки zeroRad
        }
        var target = (zeroPad + adjPow.toString(16)).substr(0,64); // subsrt вернет строку от 0 до 64 символа 


        sendJson({ 
            id    : null,
            method: "mining.set_target",
            params: [target]
        });
        return true;
    };

    this.sendMiningJob = function(jobParams){

        var lastActivityAgo = Date.now() - _this.lastActivity; // Устанавливаем время последней активности
        if (lastActivityAgo > options.connectionTimeout * 1000){ // Превышено время ожидания клиента
            _this.socket.destroy();
            return;
        }

        // if (pendingDifficulty !== null){
        //     jobParams[2] = pendingDifficulty.toString('hex'); // ? должны передавать сложность
        //     var result = _this.sendDifficulty(pendingDifficulty); // передали сложность
        //     pendingDifficulty = null; // и обнулили ее значение
        //     if (result) { // если отправка сложности прошла успешно
        //         _this.emit('difficultyChanged', _this.difficulty);
        //     }
        // }

       sendJson({ // Непосредственно отправляем работу майнеру
            id    : null,
            method: "mining.notify",
            params: jobParams
        });

    };

    this.manuallyAuthClient = function (username, password) { // "Вручную" авторизировать клиента
        handleAuthorize({id: 1, params: [username, password]}, false /*do not reply to miner*/);
    };

    this.manuallySetValues = function (otherClient) { // "Вручную" выставить параметры
        _this.extraNonce        = otherClient.extraNonce;
        _this.previousDifficulty = otherClient.previousDifficulty;
        _this.difficulty         = otherClient.difficulty;
    };
};
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;




/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
var StratumServer = exports.Server = function StratumServer(options, authorizeFn){

    //private members

    //ports, connectionTimeout, jobRebroadcastTimeout, banning, haproxy, authorizeFn

    var bannedMS = options.banning ? options.banning.time * 1000 : null; // время бана в миллисекундах

    var _this = this;
    var stratumClients = {}; // список подключившихся клиентов
    var subscriptionCounter = SubscriptionCounter(); // количество подключившихся клиентов
    var rebroadcastTimeout; // время ожидания повторной передачи работы
    var bannedIPs = {}; // Ассоциативный массив IP - время бана


    function checkBan(client){ // Проверка, есть ли данный клиент в списке забаненных
        // Если клиент отправляет большое количество не валидных шар, то его можно временно забанить. Это помогает продотвращать атаки на пул.
        if (options.banning && options.banning.enabled && client.remoteAddress in bannedIPs){
            var bannedTime = bannedIPs[client.remoteAddress]; // время бана
            var bannedTimeAgo = Date.now() - bannedTime; // сколько прошло времени
            var timeLeft = bannedMS - bannedTimeAgo; // сколько осталось времени до разбана
            if (timeLeft > 0){ // если все еще в бане
                client.socket.destroy(); // то прерываем socket-соединение с клиентом
                client.emit('kickedBannedIP', timeLeft / 1000 | 0); // и отправляем соответствующее сообщение в лог
            }
            else { // если бан кончился
                delete bannedIPs[client.remoteAddress]; // Удаляем бан из списка
                client.emit('forgaveBannedIP'); // и отправляем соответствующее сообщение в лог
            }
        }
    }

    this.handleNewClient = function (socket){ // Подключился новый клиент

        socket.setKeepAlive(true); // этот метод включает/отключает сохранение TCP протокола
        var subscriptionId = subscriptionCounter.next(); // генерируем ID для нового клиента
        var client = new StratumClient(
            {
                subscriptionId: subscriptionId, 
                authorizeFn: authorizeFn, //FIXME
                socket: socket,
                banning: options.banning,
                /*
                {
                    "enabled": true, 
                    "time": 600,    На какое время забанить клиента
                    "invalidPercent": 50,   какой процент не валидных шар должен прислать клиент, чтобы его забанили
                    "checkThreshold": 500,  через каждое указанное здесь количество шар будет проверятся процент не валидных
                    "purgeInterval": 300    Через этот временной промежуток будет очищаться список банов
                }
                */
                connectionTimeout: options.connectionTimeout, // Если за это время от клиента нет никакой связи, отключаем его
                tcpProxyProtocol: options.tcpProxyProtocol
            }
        );

        stratumClients[subscriptionId] = client; // записываем ассоциативный массив нового клиента
        _this.emit('client.connected', client); // посылаем сигнал, что клиент подключился к stratum серверу
        client.on('socketDisconnect', function() { // Приходит сигнал, что socket-соединение разорвано
            _this.removeStratumClientBySubId(subscriptionId); // удаляем клиента из списка
            _this.emit('client.disconnected', client); // посылаем сигнал, что соединение с клиентом разорвано (НЕ ИСПОЛЬЗУЕТСЯ)
        }).on('checkBan', function(){
            checkBan(client);
        }).on('triggerBan', function(){
            _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };


    this.broadcastMiningJobs = function(jobParams){ // Функия, распределяющая работу по майнерам
        for (var clientId in stratumClients) { // Для каждого клиента из ассоциативного массива клиентов
            var client = stratumClients[clientId]; 
            client.sendMiningJob(jobParams); // отсылаем каждому клиенту работу
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        clearTimeout(rebroadcastTimeout); // Время передачи работы обнуляется
        rebroadcastTimeout = setTimeout(function(){ // Через каждые  options.jobRebroadcastTimeout * 1000 вызывается emit 'broadcastTimeout'
            // однако если все работает нормально, то раньше выполниться функция clearTimeout(rebroadcastTimeout), которая обнулит время 
            // ожидания и не даст данной функции вызваться.
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };



    (function init(){

        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        // Интервал для мониторинга забаненных IP для того, чтобы удалять их и предотвращать утечки памяти.
        if (options.banning && options.banning.enabled){
            setInterval(function(){
                for (ip in bannedIPs){
                    var banTime = bannedIPs[ip];
                    if (Date.now() - banTime > options.banning.time) // Проверка: если бан кончился, то удаляем ip из списка забаненных
                        delete bannedIPs[ip];
                }
            }, 1000 * options.banning.purgeInterval);
        }


        //SetupBroadcasting();

        if ((typeof(options.tlsOptions) !== 'undefined' && typeof(options.tlsOptions.enabled) !== 'undefined') && (options.tlsOptions.enabled === "true" || options.tlsOptions.enabled === true)) {
            TLSoptions = {
                key: fs.readFileSync(options.tlsOptions.serverKey),
                cert: fs.readFileSync(options.tlsOptions.serverCert),
                requireCert: true
            }
        }

        var serversStarted = 0; // Для каждого порта будет открыт собственный локальный TCP/TLS сервер. Это их счетчик.
        for (var port in options.ports) {
            if (options.ports[port].tls === false || options.ports[port].tls === "false") { // Выбираем обычное TCP соединение
                net.createServer({allowHalfOpen: false}, function(socket) { // создаем net сервер
                    _this.handleNewClient(socket); // устанавливаем соединение с новым клиентом
                }).listen(parseInt(port), function() { // Функция listen слушает указанный в первом аргументе порт. Функция, указанная во 2 
                    // аргументе начинает выполняться.
                serversStarted++; // Инкрементируем serversStarted
                if (serversStarted == Object.keys(options.ports).length) // Если для всех портов инициализированы свои локальные TCP/TLS 
                    // сервера, то генерируется emit 'started'.
                    _this.emit('started');
                });
            } else { // Выбираем защищенное TLS соединение
                tls.createServer(TLSoptions, function(socket) {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), function() {
                    serversStarted++;
                    if (serversStarted == Object.keys(options.ports).length)
                        _this.emit('started');
                });
            }
        }
    })();


    //public members

    this.addBannedIP = function(ipAddress){ // Добавляем в ассоциативный массив время бана для ID клиента
        bannedIPs[ipAddress] = Date.now();
        /*for (var c in stratumClients){
            var client = stratumClients[c];
            if (client.remoteAddress === ipAddress){
                _this.emit('bootedBannedWorker');
            }
        }*/
    };

    this.getStratumClients = function () {
        return stratumClients;
    };

    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };

    this.manuallyAddStratumClient = function(clientObj) { // "Вручную" добавить клиента к серверу
        var subId = _this.handleNewClient(clientObj.socket); // Записываем ID для клиента
        if (subId != null) { // not banned!
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass); // Авторизация
            stratumClients[subId].manuallySetValues(clientObj); // Задать значения extranonce, difficulty и previousdifficulty для нового клиента
        }
    };

};
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
