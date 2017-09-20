var http = require('http');
var cp = require('child_process');
var events = require('events');

var async = require('async');

/**
 * The daemon interface interacts with the coin daemon by using the rpc interface.
 * in order to make it work it needs, as constructor, an array of objects containing
 * - 'host'    : hostname where the coin lives
 * - 'port'    : port where the coin accepts rpc connections
 * - 'user'    : username of the coin for the rpc interface
 * - 'password': password for the rpc interface of the coin
 **/

function DaemonInterface(daemons, logger) {

    //private members
    var _this = this;
    logger = logger || function (severity, message) {
            console.log(severity + ': ' + message);
        };


    var instances = (function () {
        for (var i = 0; i < daemons.length; i++)
            daemons[i]['index'] = i;
        return daemons;
    })();


    function init() { // 1. Начинаем выполнять функцию init()
        isOnline(function (online) { // 2. Запускаем функцию isOnline(), аргументом которой является функция-callback function (online) {}.
            if (online)
                _this.emit('online');
        });
    }

    function isOnline(callback) { // 3. Запускаем функцию isOnline, аргументом которой является переменная callback. Смотрим п.2, делаем вывод,
        // что callback == function (online) {}. Следовательно, выполнять эту функцию мы начнем тогда, когда она будет вызвана в коде ниже.
        cmd('eth_syncing', [], function (results) { // 4. Запускаем функцию cmd.
            var allOnline = results.every(function (result) { // Если есть хоть один error, то заканчиваем выполнение функции.
                return !results.error;
            });
            callback(allOnline); // Вызываем callback для функции isOnline в функции init()
            if (!allOnline)
                _this.emit('connectionFailed', results);
        });
    }


    function performHttpRequest(instance, jsonData, callback) { // 9. Начинаем выполнять performHttpRequest
        var options = { // 10. Cоставляем обьект 'options'
            hostname: (typeof(instance.host) === 'undefined' ? '127.0.0.1' : instance.host),
            port: instance.port,
            method: 'POST',
            auth: instance.user + ':' + instance.password,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': jsonData.length
            }
        };

        var parseJson = function (res, data) {
            var dataJson;

            if (res.statusCode === 401) {
                logger('error', 'Unauthorized RPC access - invalid RPC username аor password'); // А вот и ебаный логгер
                return;
            }

            try {
                dataJson = JSON.parse(data);
            }
            catch (e) {
                if (data.indexOf(':-nan') !== -1) {
                    data = data.replace(/:-nan,/g, ":0");
                    parseJson(res, data);
                    return;
                }
                logger('error', 'Could not parse rpc data from daemon instance  ' + instance.index // еще один
                    + '\nRequest Data: ' + jsonData
                    + '\nReponse Data: ' + data);

            }
            if (dataJson)
                callback(dataJson.error, dataJson, data); // Записали, и теперь вызываем callback-функцию для performHttpRequest.
        };

        var req = http.request(options, function (res) { // 11. Выполняем HTTP-запрос по параметрам, указанным в options, таким образом, 
            // создаем HTTP-клиента для передачи ему HTTP-запросов. Аргумент callback-функции res - это присылаемый от HTTP-клиента ответ.
            var data = ''; // Переменная, куда будут записывается присылаемые данные.
            res.setEncoding('utf8'); // Устанавливаем кодировочку.
            res.on('data', function (chunk) { // При регистрации сигнала 'data' вызывается функция, которая записывает кусок присланных
                // данных в переменную data.
                data += chunk;
            });
            res.on('end', function () { // При регистрации сигнала 'end' вызываем функцию parseJson.
                parseJson(res, data);
            });
        });

        req.on('error', function (e) {
            if (e.code === 'ECONNREFUSED')
                callback({type: 'offline', message: e.message}, null);
            else
                callback({type: 'request error', message: e.message}, null);
        });

        req.end(jsonData);
    }


    //Performs a batch JSON-RPC command - only uses the first configured rpc daemon
    /* First argument must have:
     [
     [ methodName, [params] ],
     [ methodName, [params] ]
     ]
     */

    function batchCmd(cmdArray, callback) {

        var requestJson = [];

        for (var i = 0; i < cmdArray.length; i++) { // Составляем RPC-запрос из партии, переданной в аргументе cmdArray
            requestJson.push({
                method: cmdArray[i][0],
                params: cmdArray[i][1],
                id: Date.now() + Math.floor(Math.random() * 10) + i,
                jsonrpc:"2.0"
            });
        }

        var serializedRequest = JSON.stringify(requestJson); // Конвертируем получившиеся RPC-запросы в строку JSON

        performHttpRequest(instances[0], serializedRequest, function (error, result) {
            callback(error, result);
        });

    }

    /* Sends a JSON RPC (http://json-rpc.org/wiki/specification) command to every configured daemon.
     The callback function is fired once with the result from each daemon unless streamResults is
     set to true. */
    function cmd(method, params, callback, streamResults, returnRawData) { // 5. Запускаем функцию cmd

        var results = [];

        async.each(instances, function (instance, eachCallback) { // 6. Функция each библиотеки acync поочередно обрабатывает каждый экземпляр 
            // из массива instances. Во втором аргументе функции each содержится callback-функция с двумя аргументами - instance (содержит 
            // обрабатываемый экземпляр из масси instances) и eachCallback (выполняемая при последней итерации и выполняемая функцию return-a)

            var itemFinished = function (error, result, data) {

                var returnObj = {
                    error: error,
                    response: (result || {}).result, // У нас в result либо нихуя, либо что-то есть. Мы добавляем к нихуя/что-то есть новые
                    // данные.
                    instance: instance
                };
                if (returnRawData) returnObj.data = data; // returnRawData - булевая переменная. Если true, то необходимо помимо всего прочего
                // вернуть обратно присланные данные.
                if (streamResults) callback(returnObj); // streamResults - булевая переменная. Если true, то необходимо вернуть обратно ТОЛЬКО 
                // присланные данные. Выполняем callback для функции cmd в функции isOnline.
                else results.push(returnObj); // Добавляем returnObj к results
                eachCallback();
                itemFinished = function () {
                };
            };

            var requestJson = JSON.stringify({ // 7. Составляем JSON для JSON-RPC запроса.
                method: method,
                params: params,
                id: Date.now() + Math.floor(Math.random() * 10),
                jsonrpc:"2.0"
            });

            performHttpRequest(instance, requestJson, function (error, result, data) { // 8. Выполняем performHttpRequest
                itemFinished(error, result, data); // В функции ParseJson встречаем callback, значит, выполняется эта функция.
                // result - data в JSON-е, data - присланные как есть данные
            });

        }, function () {    
            if (!streamResults) {
                callback(results); // Выполняем callback для функции cmd в функции isOnline
            }
        });

    }


    //public members

    this.init = init;
    this.isOnline = isOnline;
    this.cmd = cmd;
    this.batchCmd = batchCmd;
}

DaemonInterface.prototype.__proto__ = events.EventEmitter.prototype;

exports.interface = DaemonInterface;