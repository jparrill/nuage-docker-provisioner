/**
 *  Copyright 2014 Nuage Networks
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

var superagent = require('superagent')

var _host, _user, _authorization;
var _url = "https://localhost:443/nuage/api/v3_0"
var _organization = "test"
var _token = null
var _verbose = true

// Maintain API call stats
var stats = { GET : 0, PUT : 0, DELETE : 0, POST : 0 };

var HttpsAgent = require('agentkeepalive').HttpsAgent;

var keepaliveAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveTimeout: 30000 // free socket keepalive for 30 seconds
});

exports.set_verbose = function( verbose ) {
   _verbose = verbose
}

function pollForEvents(eventHandler,uuid,verbose) {
	exports.get( "/events" + ( uuid ? "?uuid=" + uuid : ""), "", function (res) {
		if (verbose) console.log( "Event channel response:" + JSON.stringify(res) )
		for ( var e in res.events ) {
			eventHandler( res.events[e] )
		}
		// XXX May eventually run out of stack space
		pollForEvents( eventHandler, res.uuid, verbose );
	}, function (err) {
		console.error( "Error: event channel closed: " + err )
	}, !verbose )
}

function getLatestAPIVersionURL(host,callback) {
	if (_verbose) console.info( "Getting latest API info from VSD at " + host );
	superagent.get( "https://" + host + ":443/nuage" )
		.agent(keepaliveAgent)
		.end( function(err,res) {
			if (res && res.ok) {

				// For some reason, superagent doesn't parse the body
				var body = JSON.parse( res.text );
				console.info( "VSD API version: " + body.versions[0].url )
				callback( body.versions[0].url );
			} else {
				console.error( "Error determining VSD API version:" + err + " details=" + JSON.stringify(res) );
			}
		})
}

function getToken(callback) {
	if (_verbose) {
		console.info( "Getting token from :" + _url + "/me" );
		console.info( "Authorization: " + _authorization )
	}
	superagent.get( _url + "/me" )
		.agent(keepaliveAgent)
		.set( 'Authorization', "XREST " + _authorization )
		.set( 'X-Nuage-Organization', _organization )
		.end( function(err,res) {
			if (res && res.ok) {
				var apiKey = res.body[0].APIKey;
				_token = "XREST " + new Buffer( _user + ':' + apiKey ).toString('base64');
				if (_verbose) console.info('getToken success! Body = ' + JSON.stringify(res.body) + '\nkey=' + apiKey + '\ntoken=' + _token );
			} else {
				console.error('Oh no! error ' + err + ( res ? res.text : "" ));
			}
			// always, also in case of error
			callback(res);
		});
}

/**
 * VSD API initialization function - authenticates with VSD
 *
 * @param {String} host IP or FQDN for the VSD instance to address ( assumes v3_0 )
 * @param {String} organization VSD Organization context to use/modify
 * @param {String} user The username to connect as
 * @param {String} password Password for the given user
 * @param {Function} Callback to be called with the response upon completion
 */
exports.init = function( host, organization, user, password, callback ) {
	_host = host;
	_user = user;
	_authorization = new Buffer( user + ':' + password ).toString('base64')
	_organization = organization;

	// Ignore TLS error of self-signed cert
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

	getLatestAPIVersionURL( host, function(api_url) {
		_url = api_url;

		// get token
		getToken( function(res) {
			// Allow app to receive push events
			callback( res, function(eventhandler,verbose) {
				pollForEvents( eventhandler, null, verbose );
			}); // always, also in case of error
		});
	})
}

/**
 * Internal helper function to make REST API calls
 */
function makeRESTcall( req, body, filter, onSuccess, onError, no_log, isRetry ) {

	// Update stats before making the call
	++stats[ req.method ];

	req.set( 'Authorization', _token )
		.set( 'X-Nuage-Organization', _organization )
		.set( 'X-Nuage-Filter', filter ? filter : "" )
		// .set( 'Connection', keep_alive ? "keep-alive" : "close" )
		.agent(keepaliveAgent)
		.send( body )
		.end( function(e,res) {
			var err = e || res.error;
			if (err) {

				// Get new token if expired, don't loop endlessly
				if ( err == "Error: Unauthorized" && !isRetry ) {
					console.info( "Refreshing token..." );
					getToken( function(res) {
						if ( res && res.ok ) {
							// need to clone 'req'
							makeRESTcall( req.clone(), body, filter, onSuccess, onError, no_log, true )
						}
					})
				} else if ( onError ) {
					onError( err );
				} else {
					console.error( "Error in REST call: " + err )
				}
			} else {
				if (_verbose && !no_log) console.log( "REST call status: " + res.status );
				!onSuccess || onSuccess( res.body )	// body can be null
			}
		} )
}

/**
 * GET method to retrieve objects
 * @param {String} path Path to the object to retrieve
 * @param {String} filter Optional filter expression to use
 * @param {Function} onSuccess Callback to call upon completion (res)
 * @param {Function} onError [optional] callback to call upon errors (err)
 *
 */
exports.get = function( path, filter, onSuccess, onError, no_log ) {
   if (_verbose && !no_log) console.info( "GET: path = " + path + " filter = " + filter )
   makeRESTcall( superagent.get( _url + path ), "", filter, onSuccess, onError, no_log )
}

/**
 * POST method to create a new object
 * @param {String} path Path to the collection of objects in which to create
 * @param {String} body Properties of the new object
 * @param {Function} onSuccess Callback to call upon completion (res)
 * @param {Function} onError [optional] callback to call upon errors (err)
 */
exports.post = function( path, body, onSuccess, onError ) {
   if (_verbose) console.info( "POST: path = " + path + " body = " + JSON.stringify(body) )
   makeRESTcall( superagent.post( _url + path + "?responseChoice=1" ), body, "", onSuccess, onError )
}

/**
 * POST method to create a new object, with Proxy user header
 * @param {String} proxyUser Proxy user in the form 'enterprise@username'
 * @param {String} path Path to the collection of objects in which to create
 * @param {String} body Properties of the new object
 * @param {Function} onSuccess Callback to call upon completion (res)
 * @param {Function} onError [optional] callback to call upon errors (err)
 */
exports.proxy_post = function( proxyUser, path, body, onSuccess, onError ) {
   if (_verbose) console.info( "POST with proxy user: proxyUser="+proxyUser+" path = " + path + " body = " + JSON.stringify(body) )
   makeRESTcall( superagent.post( _url + path ).set( 'X-Nuage-ProxyUser', proxyUser ), body, "", onSuccess, onError )
}

/**
 * PUT method to modify an existing object
 * @param {String} path Path to the object to modify
 * @param {String} body Modifications to make
 * @param {Function} onSuccess Callback to call upon completion (res)
 * @param {Function} onError [optional] callback to call upon errors (err)
 */
exports.put = function( path, body, onSuccess, onError ) {
   if (_verbose) console.info( "PUT: path = " + path + " body = " + JSON.stringify(body) )
   makeRESTcall( superagent.put( _url + path + "?responseChoice=1" ), body, "", onSuccess, onError )
}

/**
 * DELETE method to remove an object
 * @param {String} path Path to the object to remove
 * @param {Function} onSuccess Callback to call upon completion (res)
 * @param {Function} onError [optional] callback to call upon errors (err)
 */
exports.del = function( path, onSuccess, onError ) {
   if (_verbose) console.info( "DELETE: path = " + path )
   makeRESTcall( superagent.del( _url + path + "?responseChoice=1" ), "", "", onSuccess, onError )	// can use filter expression?
}

/**
 * First tries to retrieves an object, then calls POST to create it if not found
 * @param {String} path Path to find/create the object
 * @param {Object} obj Object to create if not found
 * @param {String} Filter expression for the lookup
 * @param {Function} onSuccess Callback to call upon completion (res)
 * @param {Function} onError [optional] callback to call upon errors (err)
 */
exports.get_post = function( path, obj, filter, onSuccess, onError ) {
   if (_verbose) console.info( "get_post: path = " + path + " obj=" + JSON.stringify(obj) )

   var create_if_not_exists = function() {
	 exports.post( path, obj, function (res) {
		!onSuccess || onSuccess( res, true )
	 }, onError );
   }

   exports.get( path, filter, function (body) {
	 if ( body && body[0] ) {
		!onSuccess || onSuccess( body );	// pass as array
	 } else {
		create_if_not_exists();
	 }
   } , create_if_not_exists );
}

exports.getHost = function() {
	return _host;
}

exports.print_stats = function () {
	console.info( "VSD API calls statistics: " + JSON.stringify(stats) );
}
