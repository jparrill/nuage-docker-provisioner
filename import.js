#!/usr/bin/env node

/**
	Node.js script to provision Nuage VSP from a JSON template file
	Author: Jeroen van Bemmel ( jeroen.van.bemmel@alcatel-lucent.com ), NPI team

	Install:
	  apt-get install node
	  npm install cjson

  Env Vars:
    VSP_NUAGE_USER
    VSP_NUAGE_PASS
    OS_TENANT_NAME
    OS_USERNAME
    OS_PASSWORD
    OS_AUTH_URL

	Run:
	  node ./import.js <VSD IP> <Organization name> <Nuage Template file (JSON format)>
**/

var args = process.argv.slice(2)
var vsd_ip = args[0]
var enterprise = args[1]
var jsonFile = args[2];
var nuage_user = process.env.VSP_NUAGE_USER
var nuage_pass = process.env.VSP_NUAGE_PASS
var cmd_params = {}, jsonFile = "/dev/stdin";

if ( args[2] ) {
  if (args[2].indexOf("parameters=") == 0) {
    cmd_params = JSON.parse(args[2].substring(11));
    if ( args[3] ) jsonFile = args[3];
  } else {
    jsonFile = args[2];
  }
}

var doDelete = false;	// TODO implement
var runWebservice = false
var apiErrors = 0;

if ( vsd_ip && enterprise && jsonFile ) {
  console.log( "VSD IP: " + vsd_ip + " Organization:" + enterprise + " JSON file:" + jsonFile );
  console.log( "Nuage User: " + nuage_user + " Nuage Pass:" + nuage_pass );
} else {
  console.log( "Usage: ./import.js <VSD IP> <Organization name> [ samples/xyz ]" );
  process.exit(-1)
}

// Check if Openstack env is setup
var useOS = process.env.OS_TENANT_NAME && process.env.OS_USERNAME && process.env.OS_PASSWORD && process.env.OS_AUTH_URL
console.log( "Openstack environment configured: " + useOS + "( URL= " + process.env.OS_AUTH_URL + " )" )

var api = require('./vsd-api.js')

// Remember name-2-id mapping
var name_2_id = {}
var name_2_parentId = {}

// Mapping of redirect targets to ESI
var rt_2_esi = {}

// Pending createRecursive calls waiting on resolution, indexed by <setname>.<name>
var to_resolve = {}

// Nuage object key fields, these are used in filter expressions
var key_fields = [ "name", "priority", "type", "actualType", "value", "userName", "nextHopIp", "address", "minAddress" ];

// Determines a unique key for the object. Most objects have 'name', but some are special ( VLANs, users, ACL entries, address ranges, static routes, DHCP options... )
function getKey(obj) {
	for ( var f in key_fields ) {
		var key = obj[ key_fields[f] ]
		if ( typeof key != "undefined" ) return key;
	}
	console.log( "Warning: No key defined for object: " + JSON.stringify(obj) )
	return undefined		// could use 'externalId' and generate a hash
}

function finishResolution(rs) {
  for ( var i=0; i<rs.waiting.length; ++i ) {
	var c = rs.waiting[i];
	// c.dont_postpone = true;		// avoid infinite loop? Can have more than 1 ID to resolve, sequentially
	console.log( "Finish resolving context=" + JSON.stringify(c) );
	if ( c.callback ) {
		c.callback();
	} else {
		console.error( "No callback provided!" );
		process.exit( -11 );
	}
  }
  delete to_resolve[ rs.key ]
}

// Postpone instantiation of domains and l2domains, and VM creation
var domains, l2domains, vms;

// Also postpone NSGateways and NSGRedundancyGroups, else VLAN conflict may arise
var nsgateways, nsgredundancygroups;

var enterprise_id;

var aws_stacks;

// Requires AWS credentials in env properties
function createAWSStacks(stacks) {
	var AWS = require("aws-sdk");

	// TODO resolve parameters in stack JSON
	var calls = stacks.length - 1;
	for ( var s=0; s<stacks.length; ++s ) {
		var stack = stacks[s];
		var cloudformation = new AWS.CloudFormation( { region: stack.region ? stack.region : "us-west-1", maxRetries: 3 } );

		// API does not like unknown params, TemplateBody needs to be a string
		delete stack.region;
		if ( stack.TemplateBody ) stack.TemplateBody = JSON.stringify( stack.TemplateBody );

		cloudformation.createStack( stack, function(err, data) {
			if (err) console.log(err, err.stack); // an error occurred
			else     console.log(data);           // successful response

			if (--calls <=0) {
				doExit();
			}
		});
	}
}

function doExit() {
  // Check for pending failed resolutions, can point to config errors
  var exit = !runWebservice;

  if ( nsgateways ) {
	 var gs = nsgateways;
	 nsgateways = null;
	 for ( var t in gs ) {
		createRecursive( createContext(enterprise_id,"nsgateways",gs[t]) );
	 }
  } else if ( nsgredundancygroups ) {
	 var gs = nsgredundancygroups;
	 nsgredundancygroups = null;
	 for ( var t in gs ) {
		createRecursive( createContext(enterprise_id,"nsgredundancygroups",gs[t]) );
	 }
  } else if ( domains || l2domains ) {
	 var d = domains, l2 = l2domains;
	 domains = null;
	 l2domains = null;

	 // Build in some delay to give VSD a chance to finish domain instantiations...
	 if ( d ) {
		console.log( "Instantiating L3 domains..." );
		for ( var t in d ) {
			createRecursive( createContext(enterprise_id,"domains",d[t]) );
		}
	 }
	 if ( l2 ) {
		console.log( "Instantiating L2 domains..." );
		for ( var t in l2 ) {
			createRecursive( createContext(enterprise_id,"l2domains",l2[t]) );
		}
	 }
  } else if ( vms ) {
	 var v = vms;
	 vms = null;
	 createVMs( v );
  } else {
    if (aws_stacks) {
		var s = aws_stacks;
		aws_stacks = null;
		createAWSStacks(s);
	} else {

		var exitCode = 0;
		for ( r in to_resolve ) {
		   console.warn( "Unable to resolve: '" + r + "' (check spelling, case sensitive!) recurse="+to_resolve[r].recurse )
		   ++exitCode;
		}
		if (!runWebservice) {
       console.info( "doExit: exiting nesting=" + nesting + " API errors=" + apiErrors );
		   api.print_stats();
		   process.exit( exitCode );
		}
	}
  }
}

function incRef( rs ) {

  if (!rs) rs = {
	recurse : 0
  }
  ++rs.recurse	// increase counter
  // console.debug( "incRef: " + rs.key + " -> " + rs.recurse )
  return rs
}

function decRef( rs ) {
	if ( rs ) {
	   if (--rs.recurse <= 0) {
	     console.log( "ID for " + rs.key + " now resolvable" )
		 finishResolution(rs)
	   }
	   // console.debug( "decRef: " + rs.key + " -> " + rs.recurse )
	}
}

function putIDs( context, root, ids ) {

   // deal with case where resolution gets postponed
   for ( var t in ids ) {
	  var resolved = resolveStr( ids[t], context, function() { putIDs(context,root,ids); } )
	  if ( !resolved ) {
		 if ( context.dont_postpone ) process.exit(-7)
		 return;
	  }
	  ids[t] = resolved;
   }

   ++nesting;
   api.put( root, ids, function (body) {
	  // decRef(rs)
	  if ( --nesting==0 ) doExit()
   }, onError )
}

function createArrays(context,id)
{
	var template = context.template;
	for ( var p in template ) {
		var t = template[p]

		if ( (t instanceof Array) ) {
			// Samples of Arrays of strings: User IDs, vport tags, hub domains, ...
			var root = '/' + context.set + '/' + id;
			if ( typeof(t[0]) == "string" ) {
				if ( p != "actualValues" ) {	// skip DHCP option values
					putIDs( context, root + '/' + p, t );
				}
			} else {
			  for ( var i in t ) {

				var subContext = {
				  root : root,
				  set : p,
				  template : t[i],
				  count : context.count	// Value of '#count' passed down to children
				  // rs : incRef(context.rs)
			    }
				console.info( "createArrays: calling createRecursive root="+root );
		        createRecursive( subContext )
		      }
			}
		}
	}
}

function onResponse( context, obj ) {
	var id = obj.ID
	var key = getKey(obj)
	var template = context.template
	var vlanMapped = false
	console.log( "onResponse -> Object created/obtained in set "+context.set+" key='"+key+"' ID=" + id )

	if (typeof key != "undefined") {
		name_2_id[ context.set + "." + key ] = id;
		console.log( "Added mapping '" + context.set + "." + key + "' => " + id );

		// For VLANs, also add mapping for user mnemonic ( VLAN ID not unique for different ports )
		if ( obj.userMnemonic ) {
			console.log( "Adding mapping for VLAN using mnemonic: " + obj.userMnemonic )
			name_2_id[ context.set + "." + obj.userMnemonic ] = id;
			incRef( to_resolve[ context.set + "." + obj.userMnemonic ] );
			vlanMapped = true;
		} else if ( context.set=="vlans" ) {
			console.error( "Unable to map VLAN userMnemonic: " + JSON.stringify(obj) );
		}
	}

	// Check if any pending calls are now resolvable
	// Make sure object is fully constructed before resuming
	incRef( to_resolve[ context.set + "." + key ] )
	// incRef( context.rs )

	createArrays( context, id );

	// For L3 domains or L2 domains, import subnets into Openstack
	if ( useOS ) {
		if (context.set == "domains") {
			// Add some delay, as VSD takes time to instantiate the subnets, especially shared subnets
			++nesting;
			console.log( "Starting delayed creation of Openstack networks...nesting=" + nesting );
			setTimeout( function() {
				createOpenstackSubnets( id, obj.name );
				if ( --nesting==0 ) doExit();
			}, params.delay ? params.delay : 3000 );
		} else if ( context.set == "l2domains" ) {
			createOpenstackSubnetForL2domain( id, obj.name );
		}
	}

	// After recursing, check if any pending createRecursive calls can now be resolved
	// decRef( context.rs )

	// Finally, check the parent ( if any )
	decRef( to_resolve[ context.set + "." + key ] );
	if (vlanMapped) decRef( to_resolve[ context.set + "." + obj.userMnemonic ] );

	return false;
}

var nesting = 0

// User specified 'parameters' array ( "$name" = "value" }
var params = {}

function resolveStr( val, context, callback )
{
	// Only modify strings
	if ( typeof(val) != "string" ) return val;

	// First resolve any ${param}, then check for ID resolution
	val = val.replace( /\${[^}]+}/g, function (m) {

	   // remove '${...}'
	   var v = m.substring(2,m.length-1)

	   // TODO could support nesting
	   if ( v.indexOf("ESI:") === 0 ) {
	      var name = v.substring(4)
		  var lookup = rt_2_esi[ name ]

		  // If not found, return v as "[ESI:....]"
		  v = lookup ? lookup : "[" + v + "]"

	   } else if ( v.indexOf("#count") >= 0 ) {
		  v = eval( v.replace("#count", context.count ) );
	   } else if ( params[v] ) {
		  v = params[v]
	   } else if ( context.template[v] ) {
		  v = context.template[v]
	   } else {
		  console.error( "Parameter in string '" + val + "' undefined: " + m )
		  process.exit(1)
	   }
	   console.log( "Resolved: " + m + " => " + v );
	   return v;
	})

  var len, mapping;
  if ( val.indexOf("ID:") === 0 ) {
     len = 3;
	 mapping = name_2_id;
  } else if ( val.indexOf("[ESI:") >= 0 ) {
     var st = val.indexOf("[ESI:")
	 var en = val.indexOf(']',st)
     val = val.substring(st,en)
     len = 5;
	 mapping = rt_2_esi;
  } else if ( val.indexOf("parentID:") === 0 ) {
     len = 9;
	 mapping = name_2_parentId;
  } else {
     return val; // updated string, may be unmodified
  }

  var dot = val.indexOf('.')
  p_set = val.substring(len,dot)
  p_name = val.substring(dot+1)

  // If not found, wait for any parallel API calls
  var obj = p_set + "." + p_name
  var resolved = mapping[ obj ];
  if ( resolved ) {
	  console.log( "Resolved " + val + " to " + resolved )
  } else if (!context.dont_postpone) {

	  // Put this here to distinguish redundancygroups versus single gateways
	  // template["ID.base"] = p_set

	  if ( to_resolve[ obj ] == null ) {
  		to_resolve[ obj ] = {
  		   "key" : obj,
  		   "recurse" : 0,
  		   "waiting" : []  // Array of context objects
  		}
	  }
	  context.callback = callback;
	  to_resolve[ obj ].waiting.push( context )

    // Support implicit lookups by name; trigger a GET
	  ++nesting;
	  api.get( "/" + p_set, "name == '" + p_name + "'", function (named_obj) {
                if (named_obj[0]) onResponse( { set : p_set }, named_obj[0] );
		if ( --nesting==0 ) doExit();
	  }, onError );

	  console.log( "Resolution postponed for " + val )
  } else {
      console.warn( "Unable to resolve: " + obj + " but dont_postpone flag set!" );
  }
  return resolved	// resolved ID or null if postponed
}



// Resolve names to IDs or parameters where needed
function resolveVars( context, callback ) {
 // e.g. "ID:zonetemplates.web1"
 var instance = {}
 for ( var p in context.template ) {
    var t = context.template[p]
    if ( (t instanceof Array) && (typeof(t[0])==="string") ) {
	   console.warn( "Resolving array of strings ( vPorttags or user IDs )" )
	   var vals = []
	   for ( var i = 0; i < t.length; ++i ) {
	      var resolved = resolveStr( t[i], context, callback )
		  if (!resolved) return null
		  vals.push( resolved )
	   }
	   console.info( "Resolved array: " + JSON.stringify(vals) )
	   instance[p] = vals
	} else if ( typeof(t) === "string" && (t.length > 1) ) {
	   var resolved = resolveStr( t, context, callback )
	   if (!resolved) return null	// postpone, restart from scratch next time
	   instance[p] = resolved
	} else if (p[0]!="#") {
		instance[p] = t		// copy unmodified, excluding '#' properties like '#count'
	}
 }
 // instance["#resolved"] = true  // debug
 return instance
}

function zeropad(num, size) {
    var s = "000000000" + num;
    return s.substr(s.length-size);
}

function onError(err) {
	console.error( "Error response from API call: " + JSON.stringify(err) );
  ++apiErrors;
	if ( --nesting==0 ) doExit()
}

function createMulti( context, count ) {
	var instance = resolveVars( context, function() { createMulti(context,count) } );
	if (!instance) {
		// More variables to resolve
		return;
	}

	console.log( "createMulti COUNT="+count+" context="+JSON.stringify(context) )

	++nesting
	if (context.basename && context.template.name) {
		instance.name = context.basename + count // zeropad(count,4)
	}
	api.post( context.root + '/' + context.set, instance, function (body) {
		  if (body.length>0) {
			var id = body[0].ID
			console.info( "POST: Object created in " + context.set + " ID=" + id )
			// instance["#count"] = count
			var resultContext = {
				root : context.root,
				set  : context.set,
				template: instance,		// This one has the accurate #count and real name / resolved strings
				count: context.count
			}
			onResponse( resultContext, body[0] )
		  } else {
			console.error( "Empty response for create object at " + context.root + "/" + context.set + ":" + JSON.stringify(context.template) )
		  }
		  // decRef( context.rs )
		  if (count>1) {
		    // Update #count property
			// context.template["#count"] = count-1

			// Create new context object!
			var nextContext = {
				root 		: context.root,
				set  		: context.set,
				template 	: context.template,
				basename 	: context.basename,
				count		: count-1
			}
			createMulti( nextContext, count-1 )
		  }
		  if ( --nesting==0 ) doExit()
	 }, onError )
}

function updateObject( context, id ) {
	var instance = resolveVars( context, function () { updateObject(context,id) } );
	if (instance) {
		var path = "/" + context.set + "/" + id;
		++nesting;
		api.put( path, instance, function (res) {
			console.log( "Updated object: " + path + "=>" + JSON.stringify(res) );
			if (res[0]) {
				// Need to call onResponse e.g. to update VLAN userMnemonic mapping, and create children if any
				var resultContext = {
					root : context.root,
					set  : context.set,
					template: instance,		// This one has the accurate #count and real name / resolved strings
					count: context.count
				}
				onResponse( resultContext, res[0] )
			}

			if ( --nesting==0 ) doExit()
		}, onError );
	}
}

function createRecursive( context ) {
  // console.log( "createRecursive: context=" + JSON.stringify(context) )

  // Bulk testing feature: Allow '#count' parameter
  var template = context.template
  var basename;
  var count = 1

  var filter;

  // Allow user to specify dependencies in creation, not only for POST but also for GET
  if ( context.template.depends ) {
	 var r = resolveStr( context.template.depends, context, function() { createRecursive( context ) } );
	 if (!r) {
		console.log( "Postponing object creation due to dependency: " + context.template.depends );
		return;
	}
  }

  // Take count from parent, unless overridden at this level
  if ( template['#count'] ) {
		count = template['#count']
		basename = template.name + " "

		if (count>5000) {
			count = 5000
			console.log( "Limiting #count to #5000" )
		} else {
			console.log( "Auto-count value: " + count );
		}
		context.count = count	// override any current count

		// GET all created entities, such that we can verify the count
		filter = ""
  } else {
	 // Not all objects have a 'name' attribute, but most do
	 if ( template.name ) {
		filter = "name == '"+template.name+"'";
     } else if ( typeof template.type != "undefined" ) {		// DHCP options
		filter = "type == '"+template.type+"'";
	 } else if ( typeof template.actualType != "undefined" ) { // DHCP options, 3.2 API
		filter = "actualType == "+template.actualType;
	 } else if ( typeof template.priority != "undefined" ) {	// ACL entries have 'priority'
		filter = "priority == "+template.priority;
	 } else if ( typeof template.value != "undefined" ) {	// VLANs have value, userMnemonic not unique! DHCP options also have value, check 'type' first
		filter = "value == "+template.value
	 } else if ( template.userName ) {
		filter = "userName == '"+template.userName+"'"
	 } else if ( template.nextHopIp ) {	// static routes
	    // resolveStr only supports 1 parameter per string, need to resolve 1 here too!
		var nhIP = resolveStr( template.nextHopIp, context, function() { createRecursive(context) } );
		if (!nhIP) return;
		filter = "nextHopIp == '"+nhIP+"' and address == '" + template.address +"'"
	 } else if ( template.address ) {	// ??
		filter = "address == '"+template.address+"'"
	 } else if ( template.minAddress ) {	// address ranges
		filter = "minAddress == '"+template.minAddress+"'"
	 } else {
		console.log( "Warning: Unable to filter object: " + JSON.stringify(template) )
		filter = ""
	 }

	 // Resolve any variables in the filter? Should already be resolved...
	 if (filter && filter!="") {
		filter = resolveStr( filter, context, function() { createRecursive(context) } );
		if (!filter) return;
	 }
  }

  ++nesting;

  api.get( context.root + '/' + context.set, filter, function (objs) {
	  if ( objs && (objs.length>0) ) {

		console.info( "RESULT: " + JSON.stringify(objs) );

		// If there are multiple, add all their IDs to the name mapping
		if ( count>1 ) {

			// Check that all objects are created, in case '#count' changes between runs
			if ( count != objs.length ) {
				console.log( "Detected mismatch between #count and number of objects: " + count + "!=" + objs.length )

				// If some are missing, recreate them ( starting from highest count )
				if ( count > objs.length ) {
					context.basename = basename
					createMulti( context, count )
					if ( --nesting==0 ) doExit()
					return
				}
			}

			for ( var o = 0; o<objs.length-1; ++o ) {
				var obj = objs[o]
				var key = getKey( obj )
				if ( typeof key != "undefined" ) {
					// Use the resolved name
					name_2_id[ context.set + "." + key ] = obj.ID

					// For VLANs, also add mnemonic
					if ( obj.userMnemonic ) {
						name_2_id[ context.set + "." + obj.userMnemonic ] = obj.ID
					}
				} else {
					console.log( "Warning: unable to add ID mapping for object, no unique property" )
				}
			}
		} else {
		    var obj = objs[0]
			var id = obj.ID

			// New: For redirection targets, save the name-2-ESI mapping
			if ( obj.ESI ) {
			    console.log( "Saving ESI for Redirection Target " + obj.name + ":" + obj.ESI )
				rt_2_esi[ "redirectiontargets." + obj.name ]  = obj.ESI
			}

			// PUT to update minor changes to a single object, some of the vCenter APIs only accept PUT, not POST
			updateObject( context, id );
		}

		var is_leaf = onResponse( context, objs[count-1] )	// Pass the last object
		// decRef(context.rs)

		// Delete the last layer of child objects
		if ( doDelete && is_leaf ) {
			++nesting;
			api.del( '/' + context.set + '/' + objs[0].ID,
				function (r2) {
					if ( --nesting==0 ) doExit()
				},
				function (e2) {
					if ( --nesting==0 ) doExit()
				})
		}

	  } else if (!doDelete) {

		 console.log( "No match found for " + context.root + '/' + context.set + " with filter '" + filter + "'" )

		 if ( context.set == "gateways" ) {
			console.error( "Gateway not found: " + filter + " or no permissions to use it - please check the gateway name in your script, and make sure this organization has access" );
			process.exit(-8)
		 } else {
			 // Doesn't exist yet - create it
			 context.basename = basename
			 createMulti( context, count )
		 }
	  }
	  if ( --nesting==0 ) doExit()
  }, onError )
}

function addOffset( addr, offset ) {
	var prefix = addr.lastIndexOf(".");
	return addr.substring(0,prefix+1) + (parseInt( addr.substring(prefix+1) ) + offset);
}

function createOSNet( subnet, address_ranges, domainName /* not set for L2 domains */ )
{
	console.log( "createOSNet domain="+domainName+" subnet=" + JSON.stringify(subnet) + " ranges=" + JSON.stringify(address_ranges) );

	// Support JSON parameters in description
	var json = ( subnet.description && subnet.description[0]=='{' ) ? JSON.parse( subnet.description ) : {}

    if ( json.skip_Openstack ) {
	   console.log( "Openstack import skipped for subnet " + subnet.name );
	   return;
	}

	var name = domainName ? domainName + " - " + subnet.name : subnet.name;  // must be unique
	var Netmask = require('netmask').Netmask

	// For unmanaged L2 Neutron requires a dummy CIDR
	var cidr = new Netmask( subnet.address ? subnet.address+"/"+subnet.netmask : "101.101.101.0/24" );
	var gw = domainName && subnet.gateway ? " --gateway " + subnet.gateway : ""

	// Prior to 3.2R4 DHCP had to be disabled for Shared Subnets. Still need to specify the correct CIDR though
	if ( subnet.associatedSharedNetworkResourceID || (subnet.address == null) ) {
		gw += " --enable_dhcp False";
	}

	var exec = require('child_process').exec, child
	++nesting
	var pools = ""
	if ( address_ranges ) {
		for ( var a in address_ranges ) {
			var range = address_ranges[a];
			// Provide a way to provision non-overlapping ranges for Openstack
			var extId = range['externalID'];
			if ( extId && extId.indexOf("openstack:") == 0 ) {
				var offset = parseInt( extId.substring(10) );	// skip 'openstack:' prefix
				console.log( "Adding Openstack address offset: " + offset );
				range.minAddress = addOffset( range.minAddress, offset );
				range.maxAddress = addOffset( range.maxAddress, offset );
			}
			pools += " --allocation-pool start="+range.minAddress+",end="+range.maxAddress;
		}
	}
	var neutron_cmd = '(neutron net-list -F name --format csv | grep -q \'"' + name + '"\' || neutron net-create "' + name + '") && '
		  + 'neutron subnet-create "' + name + '" ' + cidr + ' --name "' + subnet.name + '"'
		  + gw + pools + ' --nuagenet ' + subnet.ID + ' --net-partition "' + enterprise + '"';

	console.info( "About to execute Neutron command: '" + neutron_cmd + "'" );

	child = exec( neutron_cmd, { 'env' : process.env },
		function (error, stdout, stderr) {
		console.log('createOSNet stdout: ' + stdout);
		console.log('createOSNet stderr: ' + stderr);
		if (error !== null) {
		  console.log('exec error: ' + error);
		}
		if ( --nesting==0 ) doExit()
	})
}

/**
 * Import subnets for a given domain into OpenStack
 */
function createOpenstackSubnets( domainId, domainName ) {
	// This lists all subnets globally, filter for enterprise / domain instances
	++nesting
	api.get( "/domains/" + domainId + "/subnets", "", function(e,res) {
		  if ( e || res.error ) {
			console.log( "GET /domains/<id>/subnets :" + ( e || res.error ) )
			if (res) console.error( res.text )
		  } else if ( res.body[0] ) {
		    console.info( "Creating Openstack subnets: count=" + res.body.length );
			for ( var subnet = 0; subnet < res.body.length; ++subnet ) {
				// Need to capture res.body[subnet] as a function param, else callbacks will all use last value in for loop!
				createOpenstackSubnet( res.body[subnet], domainName );
			}
		  } else {
			console.log( "No subnets found in domain: " + domainName );
		  }
		  if ( --nesting==0 ) doExit()
	})
}

function createOpenstackSubnet( subnet, domainName ) {
	++nesting;

	// For shared subnets, address ranges are under /sharednetworkresources
	var adrPath = subnet.associatedSharedNetworkResourceID
				? "/sharednetworkresources/" + subnet.associatedSharedNetworkResourceID
				: "/subnets/" + subnet.ID;

	api.get( adrPath + "/addressranges", "", function (adrRange) {

			// For shared networks, subnet.address = null but we need to specify the correct CIDR...
			// BUG workaround: For shared networks, lookup the 'address','netmask' and 'gateway' properties!
			if ( subnet.associatedSharedNetworkResourceID && (!subnet.address)) {
				++nesting;
				api.get( "/sharednetworkresources/" + subnet.associatedSharedNetworkResourceID, "", function (shared_subnets) {
					var shared_subnet = shared_subnets[0];
					console.log( "Adding missing address/netmask: " + shared_subnet.address + "/" + shared_subnet.netmask );
					subnet.address = shared_subnet.address;
					subnet.netmask = shared_subnet.netmask;
					console.log( "Adding missing gateway: " + shared_subnet.gateway );
					subnet.gateway = shared_subnet.gateway;

					createOSNet( subnet, adrRange, domainName );

					if ( --nesting==0 ) doExit()
				});
			} else {
				createOSNet( subnet, adrRange, domainName );
			}
			if ( --nesting==0 ) doExit()
	}, onError )
}

/**
 * Import subnet for a given L2 domain into OpenStack
 */
function createOpenstackSubnetForL2domain( domainId, domainName ) {
	// This lists all subnets globally, filter for enterprise / domain instances
	++nesting
	api.get( "/l2domains/" + domainId, "", function(l2doms) {
		  if ( l2doms[0] ) {
		    // console.info( JSON.stringify(res.body[0]) )
			++nesting;
			api.get( "/l2domains/" + domainId + "/addressranges", "", function (adrRanges) {
				createOSNet( l2doms[0], adrRanges )
				if ( --nesting==0 ) doExit()
			}, onError )
		  }
		  if ( --nesting==0 ) doExit()
	}, onError )
}

/**
 * Very similar to per-enterprise objects update, but this also does PUT to modify an existing object
 */
function updateGlobals( set, values ) {
	if (values.forEach) values.forEach( function(r) { updateGlobal(set,r) } );
}

function updateGlobal( set, r ) {
	// console.log( "updateGlobal set="+set+" r="+JSON.stringify(r) );
	var u = resolveVars( { template: r }, function() { updateGlobal(set,r) } );
	if (!u) return;	// resolution pending

	incRef( to_resolve[ set + "." + getKey(u) ] );

	++nesting
	api.get( "/" + set, u.name ? "name == '"+u.name+"'" : null, function(globals) {

		if ( globals[0] ) {
			var cur = globals[0]
			var key = getKey(cur);
			if (typeof key != "undefined") {
				name_2_id[ set + "." + key ] = cur.ID;

				// Keep track of parent ID too, such that we can place shared subnets in the same zone
				name_2_parentId[ set + "." + key ] = cur.parentID;
			}

			console.info( "Updating shared resource..." )

			// Cannot modify 'underlay' flag once created
			delete u.underlay;

			++nesting
			var root = "/" + set + "/" + cur.ID;
			api.put( root, u, function(body) {
				decRef( to_resolve[ set + "." + key ] );

				createArrays( { template : u, set : set, count : 0 }, cur.ID );

				if ( --nesting==0 ) doExit()
			}, onError )
		} else {
			console.warn( "Global resource not found: " + u.name )

			// Then create it
			++nesting
			api.post( "/" + set, u, function(body) {
				if (body[0]) {
					var cur = body[0]
					var key = getKey(cur);
					if (typeof key != "undefined") {
						name_2_id[ set + "." + key ] = cur.ID;

						// Keep track of parent ID too, such that we can place shared subnets in the same zone
						name_2_parentId[ set + "." + key ] = cur.parentID;

						decRef( to_resolve[ set + "." + key ] );
					}

					createArrays( { template : u, set : set, count : 0 }, cur.ID );
				}
				if ( --nesting==0 ) doExit()
			}, onError )
		}
		if ( --nesting==0 ) doExit()
	}, onError )
}

function createContext(enterprise_id,set,template) {
	return {
		root : enterprise_id ? "/enterprises/" + enterprise_id : "",	// csp will use '/'
		set : set,
		template: template
	}
}

function createVMImages( images ) {
  for ( var i in images ) {
     var img = images[i];

	 var exec = require('child_process').exec, child;

	 // May already exist
	 var format = img.url.indexOf(".iso") > 0 ? "iso" : "qcow2";
	 var cmd = 'glance image-show "'+img.name+'" || glance image-create --name "'+img.name+'" --disk-format '+format+' --container-format bare --is-public True --copy-from ' + img.url + ' ';
	 if ( img.args ) cmd += img.args;

	 console.log( "Importing Glance image: " + cmd );

	 ++nesting;
	 child = exec( cmd, { 'env' : process.env },
	  function (error, stdout, stderr) {
		console.info( "createVMImage: " + error + stdout + stderr );
		if ( --nesting==0 ) doExit()
	  }
	 );
   }
}

function createFlavors( flavors ) {
  for ( var i in flavors ) {
     var fl = flavors[i];

	 var exec = require('child_process').exec, child;

	 // May already exist
	 var cmd = 'nova flavor-show "'+fl.name+'" || nova flavor-create "'+fl.name+'" auto ' + fl.memory + ' ' + fl.disk + ' ' + fl.vcpus;

	 console.log( "Creating Flavor: " + cmd );

	 ++nesting;
	 child = exec( cmd, { 'env' : process.env },
	  function (error, stdout, stderr) {
		console.info( "createFlavor: " + error + stdout + stderr );
		if ( --nesting==0 ) doExit()
	  }
	 );
   }
}

function createVMs( vms ) {
  for ( var i in vms ) {
     var vm = vms[i];

	 var exec = require('child_process').exec, child;

	 // May already exist
	 var cmd = 'nova show "'+vm.name+'" || nova boot --image "'+vm.image+'" --flavor "'+vm.flavor+'"';
	 for ( var n in vm.vnics ) {
		var net = vm.vnics[n].split("#"); // cannot use '.' or ':'
		var domain = net[0];
		var subnet = net[1];	// "" for L2 domains
		var fixed_ip = net.length>2 ? net[2] : null;
		var fixed_mac = net.length>3 ? net[3] : null;

		var os_net_name = (subnet!="" ? domain + ' - ' + subnet : domain);

		// Need to use Neutron to specify a specific MAC, else use Nova to make it easier to delete VMs
		if ( fixed_mac ) {
		    // Set the device owner such that it can be auto-deleted
			var neutron_create_port = "neutron port-create -c id -f value --device-owner network:dhcp"
			if (fixed_ip) neutron_create_port += " --fixed-ip ip_address=" + fixed_ip
			if (fixed_mac) neutron_create_port += " --mac-address " + fixed_mac
			neutron_create_port += ' "' + os_net_name + '" | tail -n1'		// Skip "Created a new port"

			cmd += ' --nic port-id=`'+neutron_create_port+'`'
		} else {
			cmd += ' --nic net-id=`neutron net-show "'+os_net_name+'" -F id -f value`'
			if ( fixed_ip ) cmd += ',v4-fixed-ip=' + fixed_ip;
		}
	 }
	 if (vm.zone) cmd += ' --availability-zone "' + vm.zone + '"';
	 cmd += ' "' + vm.name + '"';

	 console.log( "Launching new VM: " + cmd );

	 ++nesting;
	 child = exec( cmd, { 'env' : process.env },
	  function (error, stdout, stderr) {
		console.info( "createVM: " + error + stdout + stderr );
		if ( --nesting==0 ) doExit()
	  }
	 );
   }
}

function processTemplate(template) {
 ++nesting;
 for ( var set in template ) {
   console.log( "Processing: " + set );
   switch (set)
   {
   case "parameters":
	  params = template[set];

	  // Override with command line parameters
	  for ( var p in cmd_params ) {
		 console.log( "Command line parameter: " + p + " value=" + cmd_params[p] );
		 params[p] = cmd_params[p];
	  }

	  // Resolve any references in the values
	  for ( var p in params ) {
			var res = resolveStr( params[p], { dont_postpone : true } );
			if ( res ) params[p] = res;
	  }
	  break

   case "images":
      if (useOS) createVMImages( template[set] );
	  else console.warn( "'images' defined but no Openstack parameters" );
	  continue;

   case "flavors":
      if (useOS) createFlavors( template[set] );
	  else console.warn( "'flavors' defined but no Openstack parameters" );
	  continue;

   case "vms":
      if (useOS) vms = template[set];	// postpone until networks are created
	  else console.warn( "'vms' defined but no Openstack parameters" );
	  continue;

   case "sharednetworkresources":
   case "sites":
   case "vcenters":
   case "vrsconfigs":
   case "systemconfigs":
   case "infrastructurevscprofiles":
   case "infrastructureportprofiles":
   case "infrastructuregatewayprofiles":
   case "nsgatewaytemplates":
	  updateGlobals( set, template[set] )
	  break

   case "aws-stacks":
     aws_stacks = template[set];
	 break;

   case "domains":
	 domains = template[set];
	 break;

   case "l2domains":
	 l2domains = template[set];
	 break;

   case "nsgateways":
	 nsgateways = template[set];
	 break;
   case "nsredundancygroups":
     nsredundancygroups = template[set];
	 break;

   case "gateways":
	  if ( enterprise == "csp" ) {
	      updateGlobals( set, template[set] );
		  break;
	  }
	  // else no break

   default:
      // Support conditional inclusion of JSON sections: $if and $if-not
	  if ( set.indexOf("$if")==0 ) {
		 var colon = set.indexOf(":");
		 if ( colon>0 ) {
			var expr = set.substring(0,colon);
			switch ( expr ) {
		    case "$if":
			case "$if-not":
				var flag = set.substring(colon+1);

				// Tell user to specify a value of true or false for the variables
				if ( typeof(params[flag]) == "string" && params[flag].indexOf("ASK:")==0 ) {
					console.error( "Please provide a Boolean value for the following input parameter: " + flag );
					console.error( "Description: " + params[flag].substring(4) );
					console.error( "For example: add parameters='{\""+flag+"\" : 1}'" );
					process.exit(-10);
				}

				if ( params[flag] ^ (expr=="$if-not") ) {
					console.log( "Including conditional section: " + expr + ":" + flag + "=" + params[flag] );
					processTemplate( template[set] );
				} else {
					console.log( "Excluding conditional section: " + expr + ":" + flag + "=" + params[flag] );
				}
				break;

			default:
			   console.error( "Unsupported expression: " + set );
			}
		} else {
			console.error( "Missing ':' in " + set );
			process.exit(-11);
		}
	  } else {
		  for ( t in template[set] ) {
			createRecursive( createContext(enterprise_id,set,template[set][t]) );
		  }
	  }
   }
 }

 // When a template with only 'domains' is used, the import process hangs because nothing triggers the domain instantiation
 if ( --nesting==0 ) doExit()

}

function doImport( vsd_ip, enterprise, jsonFile ) {

// Load JSON file
var cjson = require('cjson')
var template = cjson.load( jsonFile )

// Find/Create Net-partition in Openstack first
var exec = require('child_process').exec, child;

// May already exist
child = exec('[ "'+enterprise+'" = "csp" ] || neutron nuage-netpartition-create "' + enterprise + '"', { 'env' : process.env },
  function (error, stdout, stderr) {
    console.log('neutron nuage-netpartition-create stdout: ' + stdout);
    console.log('neutron nuage-netpartition-create stderr: ' + stderr);
    if (error !== null) {
      console.log('exec error: ' + error);
    }

    api.set_verbose( true )
    api.init( vsd_ip, "csp", nuage_user, nuage_pass, function(res) {
    if (!nuage_user) nuage_user = "csproot"
    if (!nuage_pass) nuage_pass = "csproot"
		if ( enterprise == "csp" ) {
			console.info( "Processing template for CSP..." );
			processTemplate( template );
		} else {
			api.get( "/enterprises", "name == '"+enterprise+"'", function(enterprises) {
				// console.log( res )
        if (enterprises && enterprises[0]) {
					enterprise_id = enterprises[0].ID;		// GLOBAL
					processTemplate( template );
				} else {
				   console.log( "Unable to find Organization named '" + enterprise + "'" );
				   process.exit(-3)
				}
				// process.exit(0) no, wait until all async calls have finished
			}, function (err) {
				console.log( "Error getting enterprise '"+enterprise+"':" + err )
				process.exit(-2)
			} )
		}
		console.log( "doImport exiting;nesting="+nesting );
    })
})	// exec close

}	// doImport

if ( runWebservice ) {
	var express = require('express');
	var PORT = 8080
	var app = express()

	var bodyParser = require('body-parser')
	var multer = require('multer')
	app.use(bodyParser.json()) // for parsing application/json
	app.use(bodyParser.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded
	app.use(multer()) // for parsing multipart/form-data

	app.get('/', function (req, res) {

		var glob = require("glob")
		var options = []
		glob("/samples/**/*.nuage", options, function (er, files) {
			var html = "<html><head><title>Nuage Network Policy import portal</title></head><body>" +
				"<form action ='import' method = 'post'>" +
				"<p>Nuage Network Policy template file: <select id='file' name='file'>"
			for ( f in files ) {
				html += "<option id='" +files[f]+"' value='" + files[f] + "'>"+files[f]+ "</option>"
			}
			html += "</select>" +
				"<p>Name of Organization to import into:<input type='text' name='org' id='org' value='Organization' /> (created if non-existing)"+
				"<p><input type='submit' value='Import Network Policy' />" +
				"</form></body></html>"

			res.send(html)
		})
	})
	app.post('/import', function (req, res) {
		console.log( "Import POST:" + JSON.stringify(req.body) )

		res.send("Importing policy file '"+req.body.file+"' into Organization: " + req.body.org + " ..." )
		doImport( vsd_ip, req.body.org, req.body.file )
	})
	app.listen(PORT)
	console.log('Running on http://localhost:' + PORT)
} else doImport( vsd_ip, enterprise, jsonFile )
