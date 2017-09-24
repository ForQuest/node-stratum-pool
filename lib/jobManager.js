var events = require('events');
var crypto = require('crypto');
var ethashVerify = require('ethashjs-verify');
var bignum = require('bignum');


var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');


//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) { // Либо переданное числового значения, либо 
    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);// псевдослучайно сгенерированное 32-х битное число сдвигается на 27 бит. Это значение и будет extranonce. 
    var counter = instanceId << 27;
    this.next = function () { // Данная функция инкрементирует counter и возращает значение extraNonce в hex строке.
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function () {
    var counter = 0x0000cccc;

    this.next = function () {
        counter++;
        if (counter % 0xffffffffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

function isHexString(s) {
    var check = String(s).toLowerCase();
    if(check.length % 2) {
        return false;
    }
    for (i = 0; i < check.length; i=i+2) {
        var c = check[i] + check[i+1];
        if (!isHex(c))
            return false;
    }
    return true;
}
function isHex(c) {
    var a = parseInt(c,16);
    var b = a.toString(16).toLowerCase();
    if(b.length % 2) {
        b = '0' + b;
    }
    if (b !== c) {
        return false;
    }
    return true;
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
var JobManager = module.exports = function JobManager(options) {


    //private members

    var _this = this;
    var jobCounter = new JobCounter();

    var shareMultiplier = algos[options.coin.algorithm].multiplier; // Для указанного в аргументе options.coin.algorithm алгоритма шифрования 
    // в класса algos (algosProperties.js) берем значение поля multiplier (в нашем случае = 1)

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId); // Передаем в options.instanceId случайное числовое значение. Лучше
    // не передавать, т.к. функция ExtraNonceCounter может сама его сгенерировать с помощью крипто-рандомного алгоритма.

    this.currentJob;
    this.validJobs = {};

    this.ethash = new ethashVerify();
    this.DAGLoaded = false;

    this.ethash.on('DAG', function(){
        this.DAGLoaded = true;
    });

    var hashDigest = algos[options.coin.algorithm].hash(options.coin); // Функция, которая по параметрам из configa выбирает метод верификации
    // блока.

    var coinbaseHasher = (function () { // нахуй не надо
        switch (options.coin.algorithm) {
            default:
                return util.sha256d;
        }
    })();


    var blockHasher = (function () { // тоже не надо
        switch (options.coin.algorithm) {
            case 'sha1':
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function (d) {
                    return util.reverseBuffer(util.sha256(d));
                };
        }
    })();

    this.updateCurrentJob = function (rpcData) { //
        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData.header, // Заголовок блока
            rpcData.seed, // Вычисляется для каждого блока. Служит для псевдорандомной генерации кэша на 16 мб. Из кэша можно сгенерировать
            // dataset на 1 GB.
            rpcData.target, // Сложность блока
            rpcData.height, // Высота блока (по сути это номер блока в сети блокчнейн)
            rpcData.difficulty, // Сложность вычислений
            rpcData.rpc,
            options.coin.reward, // Алгоритм вознаграждения за блок
            options.recipients,
            options.address // Адрес майнера.
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processTemplate = function (rpcData) {

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
         block height is greater than the one we have */
        var isNewBlock = typeof(_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.header !== rpcData.header) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.height)
                return false;
        }
        if (typeof(_this.currentJob) === 'undefined') ethash.init(rpcData.height);
        else {
            if (Math.floor(_this.currentJob.height/30000) < Math.floor(rpcData.height/30000)) {
                _this.DAGLoaded = false;
                ethash.updateEpoc(rpcData.height);
            }
        }
        
        if (!isNewBlock) return false;


        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData.header,
            rpcData.seed,
            rpcData.target,
            rpcData.height,
            rpcData.difficulty,
            rpcData.rpc,
            options.coin.reward,
            options.recipients,
            options.address
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('newBlock', tmpBlockTemplate);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };

    this.processShare = function (workerName, jobId, nonce, header, mix, difficulty, ipAddress, port, callback) {
        var shareError = function (error) {
            _this.emit('share', {
                Code: error[0],
                Message: error[1]
            });
            return {error: error, result: null};
        };

        var job = _this.validJobs[jobId];
        
        // if (!isHexString(extraNonce2)) {
        //     return shareError([20, 'invalid hex in extraNonce2']);
        // }

        if (!job.registerSubmit(header, mix, nonce)) {
            return shareError([22, 'duplicate share']);
        }

        var block = {
            height    : job.height,
            header    : header.slice(2),
            nonce     : nonce.slice(2),
            mixDigest : mix.slice(2),
        }

        console.log(block+' '+difficulty.slice(2)+' '+job.target);
        ethash.submitShare(block, difficulty.slice(2), job.target.toString(16), function(result){
            _this.emit('share', result, {
                job: jobId,
                ip: ipAddress,
                port: port,
                worker: workerName,

                header   : header,
                nonce    : nonce,
                mixDigest: mix,

                height: job.height,
                difficulty: job.target,
                shareDiff: difficulty,
                blockDiff: job.difficulty
            });

            callback({share: result.share, error: null});
        });
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
