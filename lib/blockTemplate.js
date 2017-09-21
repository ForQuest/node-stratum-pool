var bignum = require('bignum');

var merkle = require('./merkleTree.js');
var transactions = require('./transactions.js');
var util = require('./util.js');

/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(jobId, header, seed, target, height, difficulty, rpcData, extraNoncePlaceholder, reward, recipients, poolAddress){

    //private members
    var submits = [];

    //public members
    this.rpcData = rpcData;
    this.jobId = jobId;

    // get target info
    this.header = header;
    this.target = bignum(rpcData.target.slice(2), 16);
    this.seed = seed;
    this.height = height;
    this.difficulty = difficulty;

    //block header per https://github.com/zcash/zips/blob/master/protocol/protocol.pdf

    // submit the block header
    this.registerSubmit = function(header, mix, nonce){
        var submission = header + mix + nonce;
        if (submits.indexOf(submission) === -1){

            submits.push(submission);
            return true;
        }
        return false;
    };

    this.getJobParams = function(){
        if (!this.jobParams){
            this.jobParams = [
                this.jobId,
                this.header,
                this.seed,
                this.target,
                true
            ];
        }
        return this.jobParams;
    };

};
