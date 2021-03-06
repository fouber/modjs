var utils = require('../utils');
var path = require('path');
var url = require('url');
var format = require('../utils/format');
var file = require('../utils/file');
var seajs = require('../utils/sea');
var HTMLParser = require('../utils/htmlparser').HTMLParser;
var EventEmitter = require('events').EventEmitter;

exports.summary = 'Build project with html';

exports.usage = '<src> [options]';

exports.options = {
    "dest" : {
        alias : 'd'
        ,default : 'dist'
        ,describe : 'destination build directory'
    },
    "charset" : {
        alias : 'c'
        ,default : 'utf-8'
        ,describe : 'file encoding type'
    }
};

exports.run = function(options, done){

    var dest = options.dest;
    var buildQueue = [];

    exports.files.forEach(function(src){
        buildQueue.push(function(done){
            exports.log(src.green);
            exports.build(src, dest, done)
        })
    });

    // start run queue
    exports.async.series(buildQueue, done);
};


exports.build = function (source, dest, done) {

    var emitter = new EventEmitter();

    if(!file.isDirFormat(dest)){
        return exports.error('build destination must be a directory');
    }

    var helpers = exports.loadTask('template').helpers;
    var sourceString = file.read(source);
    var buffer = [];

    // xml header declaration like <?xml version="1.0" encoding="UTF-8"?>
    // strip it temporary, because htmlMinifier can not proecss it
    var xmlHeader ='';
    sourceString = sourceString.replace(/\s*<\?xml.*?>/, function(xml){
        xmlHeader = xml;
        return '';
    });

    // <html data-url-prepend="http://cdn1.qq.com/">
    var globalUrlPrepend;

    function parseUrlPrepend(attrs){
        for ( var i = 0, len = attrs.length; i < len; i++ ) {
            var attr = attrs[i];
            var attrName = attr.name.toLowerCase();
            var attrValue = attr.escaped;
            if(attrName === 'data-url-prepend'){
                return attrValue
            }
        }
        return globalUrlPrepend;
    }

    var prevTag, prevSrc, sequenceStartSrc, sequencedSrc = {};
    HTMLParser(sourceString, {
        start: function(tag, attrs, unary){
            var src;
            if( !isScriptLoader(tag, attrs) && ( src = isLocalStylesheet(tag, attrs) || isLocalScript(tag, attrs) ) &&
                tag == prevTag && prevSrc) {

                if( !sequenceStartSrc ) sequenceStartSrc = prevSrc;
                if( !sequencedSrc[sequenceStartSrc] )
                    sequencedSrc[sequenceStartSrc] = [prevSrc, src];
                else
                    sequencedSrc[sequenceStartSrc].push(src);
                // set true as a flag
                sequencedSrc[src] = true;
            }else{
                sequenceStartSrc = null;
            }

            prevSrc = src;
            prevTag = tag;
        }
    });

    var isSkippingTagEnd = false;
    // html parsing
    HTMLParser(sourceString, {
        start: function(tag, attrs, unary) {

            var src, loader, destPath;

            // parse global url prepend
            if(tag === 'html'){
                globalUrlPrepend = parseUrlPrepend(attrs);
            }

            if(loader = isScriptLoader(tag, attrs)){

                // root relative path
                var mainSrc = loader.main;
                var relativeRootMainSrc = path.join( path.dirname(source), mainSrc );

                if( loader.name === 'requirejs' ) {
                    destPath = path.join(dest, relativeRootMainSrc);
                    var compileOptions = {
                        src: path.basename(relativeRootMainSrc),
                        dest: destPath,
                        loader: loader.name,
                        baseUrl: path.dirname(relativeRootMainSrc),
                        miniLoader: true
                    };
                    buffer.push({toString: function(){
                        return '<script src="'+src+'">';
                    }});
                }else if(loader.name === 'seajs'){
                    destPath = path.join(dest, relativeRootMainSrc);
                    var loaderSrc = loader.src;
                    // FIXME: if loader src is local address, copy it
                    if(file.exists(loaderSrc)){
                        var relativeRootLoaderSrc =  path.join( path.dirname(source), loaderSrc );
                        file.write(path.join(dest, relativeRootLoaderSrc ), helpers.content(relativeRootLoaderSrc));
                        // TODO, use the local plugin file
                    }
                    var compileOptions = {
                        src: relativeRootMainSrc,
                        dest: destPath,
                        loader: loader.name
                    };
                    buffer.push({toString: function(){
                        return ['<script src="'+loaderSrc+'"></script>', '<script src="'+src+'">'].join('\n');
                    }});
                }

                // a defined option even the value is undefined will be consider a user input params, that will replace the default value
                if(loader.config){
                    // root relative path
                    var relativeRootConfigSrc  = path.join( path.dirname(source), loader.config);
                    compileOptions.mainConfigFile = relativeRootConfigSrc;
                }

                // TODO: sync compile task
                exports.runTask('compile', compileOptions, function(err){
                    // minify
                    file.write(destPath, helpers.content(destPath));
                    // rev, and use origin main src when gen src
                    src = path.join(path.dirname(mainSrc), helpers.rev(destPath));
                    // get url prepend
                    var urlPrepend = parseUrlPrepend(attrs);
                    src = url.resolve(urlPrepend, src);
                    // normalize the url
                    src = src.replace(/\\/g, '/');
                    // emit run
                    emitter.emit('output');
                });

                return;

            } else if ( src = isLocalStylesheet(tag, attrs) || isLocalScript(tag, attrs) ){

                if(src in sequencedSrc){

                    if(Array.isArray( sequencedSrc[src] )){
                        var isEmbed = isNeedEmbed(src);
                        var sequencedDirname, sequencedExtname, sequencedNames = [];
                        // combine all
                        var sequencedContents = sequencedSrc[src].map(function(src){
                            // consider project dir tree like this:
                            // css/main.css, html/index.html, js/main.js
                            // command should be "mod build html/index.html"
                            // root relative path
                            var relativeRootSrc = path.join( path.dirname(source), src);
                            sequencedDirname || (sequencedDirname = path.dirname(src));
                            sequencedExtname = file.extname(src);
                            sequencedNames.push(path.basename(src, sequencedExtname));

                            return helpers.content(relativeRootSrc, {
                                revDest: dest,
                                urlFromBase: relativeRootSrc,
                                urlToBase: isEmbed? path.dirname(source) : null
                            });
                        }).join("\n");

                        if( isEmbed ){
                            var embedContents = '';
                            if(tag === 'script'){
                                embedContents = ['<script>', sequencedContents, '</script>'].join('\n');
                            }else if(tag === 'link'){
                                embedContents = ['<style>', sequencedContents, '</style>'].join('\n');
                            }
                            buffer.push(embedContents);
                            return isSkippingTagEnd = !unary;
                        }else{
                            var sequencedName = [sequencedNames[0], sequencedNames[sequencedNames.length-1], sequencedNames.length, sequencedContents.length].join("_") + sequencedExtname;
                            var sequencedContentsDest = path.join(sequencedDirname, sequencedName);
                            // join the dest dir path
                            destPath = path.join(dest, sequencedContentsDest);
                            // minify by content helper
                            file.write( destPath, sequencedContents);
                            // print log
                            exports.log(sequencedSrc[src], '>', destPath);
                            // rev dest file, and use origin main src when gen src
                            src = path.join(path.dirname(src), helpers.rev(destPath));
                        }

                    }else{
                        return isSkippingTagEnd = !unary;
                    }

                }else{
                    // consider project dir tree like this:
                    // css/main.css, html/index.html, js/main.js
                    // command should be "mod build html/index.html"
                    // root relative path
                    var relativeRootSrc = path.join( path.dirname(source), src);
                    var isEmbed = isNeedEmbed(src);
                    // minify by content helper
                    var contents = helpers.content(relativeRootSrc, {
                        urlFromBase: relativeRootSrc,
                        urlToBase: isEmbed? path.dirname(source) : null
                    });

                    if( isEmbed ){
                        var embedContents = '';
                        if(tag === 'script'){
                            embedContents = ['<script>', contents, '</script>'].join('\n');
                        }else if(tag === 'link'){
                            embedContents = ['<style>', contents, '</style>'].join('\n');
                        }
                        buffer.push(embedContents);
                        return isSkippingTagEnd = !unary;
                    }else{
                        // join the dest dir path
                        destPath = path.join(dest, relativeRootSrc);
                        file.write(destPath, contents);
                        exports.log(src, '>', destPath);
                        // rev dest file, and use origin main src when gen src
                        src = path.join(path.dirname(src), helpers.rev(destPath));
                    }

                }

            } else if ( src = isLocalSrc(tag, attrs) ){
                // TODO optimage
                var relativeRootSrc = path.join( path.dirname(source), src);
                relativeRootSrc = file.normalize(relativeRootSrc);

                if(isNeedDataURI(src)){
                    src = exports.runTask('datauri', {src: relativeRootSrc, output: 'pipe'})
                }else{
                    // join the dest dir path
                    destPath = path.join(dest, relativeRootSrc);
                    file.copy(relativeRootSrc, destPath);
                    exports.log(src, '>', destPath);
                    // rev dest file, and use origin main src when gen src
                    src = path.join(path.dirname(src), helpers.rev(destPath));
                }
            }

            var startBuffer= [];
            startBuffer.push('<', tag);

            for ( var i = 0, len = attrs.length; i < len; i++ ) {
                var attr = attrs[i];
                var attrName = attr.name;
                var attrValue = attr.escaped;
                var attrFragment = ' '+attrName;

                if(attrName.toLowerCase() === 'data-url-prepend') continue;

                // replace src path
                if(src && (attrName.toLowerCase() === 'src' || attrName.toLowerCase() === 'href')){

                    var urlPrepend = parseUrlPrepend(attrs);
                    attrValue =  url.resolve(urlPrepend, src);
                    // fuck the windows file separator
                    attrValue = attrValue.replace(/\\/g, '/');
                }

                if(attrValue) {
                    attrValue = '"' + attrValue + '"';
                    attrFragment += '=' + attrValue;
                }

                startBuffer.push(attrFragment);

            }

            startBuffer.push('>');
            buffer.push(startBuffer.join(''));
        },

        end: function(tag) {
            if(!isSkippingTagEnd){
                buffer.push('</', tag, '>');
                isSkippingTagEnd = false;
            }
        },
        chars: function(text) {
            buffer.push(text);
        },
        comment: function(text) {
            text = '<!--' + text + '-->';
            buffer.push(text);
        },
        doctype: function(doctype) {
            buffer.push(doctype);
        }
    });


    var destHTMLPath = path.join(dest, source);
    exports.log(source, '>', destHTMLPath);

    emitter.on('output',function(){
        var destHTMLContent = buffer.join('');
        file.write(destHTMLPath, destHTMLContent);
        destHTMLContent = helpers.content(destHTMLPath);
        // if there is a xml header, put it on the top of html again
        destHTMLContent = xmlHeader + destHTMLContent;
        file.write(destHTMLPath, destHTMLContent);
        done();
    });

    emitter.emit('output');
};


function isNeedEmbed(src){
    var query = url.parse(src, true).query;
    return 'embed' in query;
}

function isNeedDataURI(src){
    var query = url.parse(src, true).query;
    return 'datauri' in query;
}

function isLocalSrc(tag, attrs){
    // img; <img src="foo.png">
    // audio: <source src="foo.mp3">
    // video: <source src="foo.mp4">
    // embed: <embed src="foo.swf">
    if( tag == 'img' || tag == 'source' ||  tag == 'embed' ){
        var isLocalLink, src;
        for ( var i = 0, len = attrs.length; i < len; i++ ) {
            var attr = attrs[i];
            var attrName = attr.name.toLowerCase();
            var attrValue = attr.escaped;
            // attr value can not be empty
            if( attrName === 'src' && attrValue && utils.isRelativeURI(attrValue) ){
                isLocalLink = true;
                src = attrValue;
            }
        }
        return isLocalLink && src;
    }
}

function isLocalObject(){
    // <object width="400" height="400" data="helloworld.swf"></object>
}

function isLocalStylesheet(tag, attrs){

    if(tag == 'link'){
        var isStylesheet, isLocalLink, href;
        for ( var i = 0, len = attrs.length; i < len; i++ ) {
            var attr = attrs[i];
            var attrName = attr.name.toLowerCase();
            var attrValue = attr.escaped;
            if( attrName === 'rel' && attrValue == 'stylesheet' ){
                isStylesheet = true;
            }else if( attrName === 'href' && attrValue && utils.isRelativeURI(attrValue) ){  // attr value can not be empty
                isLocalLink = true;
                href = attrValue;
            }
        }

        return isStylesheet && isLocalLink && href;
    }

}

function isLocalScript(tag, attrs){
    if(tag == 'script'){
        var isLocalLink, src;
        for ( var i = 0, len = attrs.length; i < len; i++ ) {
            var attr = attrs[i];
            var attrName = attr.name.toLowerCase();
            var attrValue = attr.escaped;
            // attr value can not be empty
            if( attrName === 'src' && attrValue && utils.isRelativeURI(attrValue) ){
                isLocalLink = true;
                src = attrValue;
            }
        }
        return isLocalLink && src;
    }
}

function isScriptLoader(tag, attrs){
    if(tag == 'script'){
        var hasMainConfig, loaderName, configSrc, mainSrc, loaderSrc, isLoaderLocked;
        for ( var i = 0, len = attrs.length; i < len; i++ ) {
            var attr = attrs[i];
            var attrName = attr.name.toLowerCase();
            var attrValue = attr.escaped;

            // attr value can not be empty
            if(attrValue && utils.isRelativeURI(attrValue) ){
                // requirejs and seajs use the some attr name
                if(attrName === 'data-main'){
                    hasMainConfig = true;
                    mainSrc = attrValue;
                }
                // specify the loader by user
                else if(attrName === 'data-loader'){
                    loaderName = attrValue;
                    isLoaderLocked = true;
                }
                // seajs only
                else if(attrName === 'data-config'){
                    configSrc = attrValue;
                }
            }

            // loader could be a cdn path
            if(attrName === 'src' && !isLoaderLocked){
                if( attrValue.match(/sea\.js|sea-debug\.js/) ) loaderName = 'seajs';
                else if(attrValue.match(/requirejs|require\.js/) ) loaderName = 'requirejs';
                loaderSrc = attrValue;
            }

        }

        if(hasMainConfig && loaderName){

            if(mainSrc && file.extname(mainSrc) === ''){
                mainSrc += '.js';
            }

            if(configSrc && file.extname(configSrc) === ''){
                configSrc += '.js';
            }

            return {
                name: loaderName,
                main: mainSrc,
                src : loaderSrc,
                config: configSrc // seajs only
            };

        }

    }
}

