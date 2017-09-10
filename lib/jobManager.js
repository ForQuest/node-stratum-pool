var events = require('events');
var crypto = require('crypto');

var bignum = require('bignum');


var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');


//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {
    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;
    this.next = function () {
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4; //bytes
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

    var shareMultiplier = algos[options.coin.algorithm].multiplier;

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);

    this.currentJob;
    this.validJobs = {};

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    var coinbaseHasher = (function () {
        switch (options.coin.algorithm) {
            default:
                return util.sha256d;
        }
    })();


    var blockHasher = (function () {
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

    this.updateCurrentJob = function (rpcData) {
        var tmpBlockTemplate = new blockTemplate(
            rpcData.header,
            rpcData.seed,
            rpcData.target,
            rpcData.height,
            rpcData.difficulty,
            rpcData,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.recipients,
            options.address
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.header] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processTemplate = function (rpcData) {

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
         block height is greater than the one we have */
        var isNewBlock = typeof(_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.header !== rpcData.header) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;


        var tmpBlockTemplate = new blockTemplate(
            rpcData.header,
            rpcData.seed,
            rpcData.target,
            rpcData.height,
            rpcData.difficulty,
            rpcData,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.recipients,
            options.address
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('newBlock', tmpBlockTemplate);

        _this.validJobs[tmpBlockTemplate.header] = tmpBlockTemplate;

        return true;

    };

    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {
        var shareError = function (error) {
            _this.emit('share', {
                Code: error[0],
                Message: error[1]
            });
            return {error: error, result: null};
        };

        var submitTime = Date.now() / 1000 | 0;

        if (nonce.length !== 64) {
            return shareError([20, 'incorrect size of nonce']);
        }

        if (soln.length !== 2694) {
            return shareError([20, 'incorrect size of solution']);
        }
        
        if (!isHexString(extraNonce2)) {
            return shareError([20, 'invalid hex in extraNonce2']);
        }

        if (!job.registerSubmit(header, extraNonce2, nTime, nonce)) {
            return shareError([22, 'duplicate share']);
        }

        var extraNonce1Buffer = new Buffer(extraNonce1, 'hex');
        var extraNonce2Buffer = new Buffer(extraNonce2, 'hex');

        var headerBuffer = job.serializeHeader(nTime, nonce); // 144 bytes (doesn't contain soln)
        var headerSolnBuffer = new Buffer.concat([headerBuffer, new Buffer(soln, 'hex')]);
        var headerHash = util.sha256d(headerSolnBuffer);
        var headerBigNum = bignum.fromBuffer(headerHash, {endian: 'little', size: 32});

        var blockHashInvalid;
        var blockHash;
        var blockHex;

        var shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;
        var blockDiffAdjusted = job.difficulty * shareMultiplier;

        //check if block candidate and if the equihash solution is valid
        //if (1 === 1) {
        if (headerBigNum.le(job.target) && hashDigest(headerBuffer, new Buffer(soln.slice(6), 'hex'))) {
            blockHex = job.serializeBlock(headerBuffer, new Buffer(soln, 'hex')).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');
        }
        else {
            if (options.emitInvalidBlockHashes)
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerSolnBuffer)).toString('hex');

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99) {

                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                }
                else {
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }

            }
        }

        /*
        console.log('validSoln: ' + hashDigest(headerBuffer, new Buffer(soln.slice(6), 'hex')));
        console.log('job: ' + jobId);
        console.log('ip: ' + ipAddress);
        console.log('port: ' + port);
        console.log('worker: ' + workerName);
        console.log('height: ' + job.rpcData.height);
        console.log('blockReward: ' + job.rpcData.reward);
        console.log('difficulty: ' + difficulty);
        console.log('shareDiff: ' + shareDiff.toFixed(8));
        console.log('blockDiff: ' + blockDiffAdjusted);
        console.log('blockDiffActual: ' + job.difficulty);
        console.log('blockHash: ' + blockHash);
        console.log('blockHashInvalid: ' + blockHashInvalid);
        */

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.reward,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
