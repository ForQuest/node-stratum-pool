var bignum = require('bignum');

var merkle = require('./merkleTree.js');
var transactions = require('./transactions.js');
var util = require('./util.js');

/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(header, seed, target, height, difficulty, rpcData, extraNoncePlaceholder, reward, recipients, poolAddress){

    //private members
    var submits = [];

    //public members
    this.rpcData = rpcData;

    // get target info
    this.header = header;
    this.target = bignum(rpcData.target, 16);
    this.seed = seed;
    this.height = height;
    this.difficulty = difficulty;

    //block header per https://github.com/zcash/zips/blob/master/protocol/protocol.pdf

    // submit the block header
    this.registerSubmit = function(header, soln){
        var submission = header + soln;
        if (submits.indexOf(submission) === -1){

            submits.push(submission);
            return true;
        }
        return false;
    };

    this.getJobParams = function(){
        return [this.header,this.seed,this.difficulty];
    }
};
