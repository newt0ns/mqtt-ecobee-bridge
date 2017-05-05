// Requirements
const mqtt = require('mqtt')
const logging = require('./homeautomation-js-lib/logging.js')
require('./homeautomation-js-lib/mqtt_helpers.js')
const health = require('./homeautomation-js-lib/health.js')
const repeat = require('repeat')
const request = require('request')
const f2c = require('fahrenheit-to-celsius')
const Redis = require('redis')

// create a Configstore instance with an unique ID e.g.
// Package name and optionally some default values
const host = process.env.MQTT_HOST
const ecobeeTopic = process.env.ECOBEE_TOPIC
const ecobeeClientID = process.env.ECOBEE_CLIENT_ID
const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT
const redisDB = process.env.REDIS_DATABASE
const syslogHost = process.env.SYSLOG_HOST
const syslogPort = process.env.SYSLOG_PORT

const healthCheckPort = process.env.HEALTH_CHECK_PORT
const healthCheckTime = process.env.HEALTH_CHECK_TIME
const healthCheckURL = process.env.HEALTH_CHECK_URL
if (healthCheckPort !== null && healthCheckTime !== null && healthCheckURL !== null &&
    healthCheckPort !== undefined && healthCheckTime !== undefined && healthCheckURL !== undefined) {
    logging.log('Starting health checks')
    health.startHealthChecks(healthCheckURL, healthCheckPort, healthCheckTime)
} else {
    logging.log('Not starting health checks')
}

// Set up modules
logging.set_enabled(true)
logging.setRemoteHost(syslogHost, syslogPort)

// Setup MQTT
var client = mqtt.connect(host)
var waitingForPIN = false

// MQTT Observation
const redis = Redis.createClient({
    host: redisHost,
    port: redisPort,
    db: redisDB,
    retry_strategy: function(options) {
        if (options.error && options.error.code === 'ECONNREFUSED') {
            // End reconnecting on a specific error and flush all commands with a individual error
            return new Error('The server refused the connection')
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
            // End reconnecting after a specific timeout and flush all commands with a individual error
            return new Error('Retry time exhausted')
        }
        if (options.times_connected > 10) {
            // End reconnecting with built in error
            return undefined
        }
        // reconnect after
        return Math.min(options.attempt * 100, 3000)
    }
})

// redis callbacks

redis.on('error', function(err) {
    logging.log('redis error ' + err)
})

redis.on('connect', function() {
    logging.log('redis connected')
})

client.on('connect', () => {
    logging.log('Reconnecting...\n')
    client.subscribe(ecobeeTopic + '/set/mode')
    client.subscribe(ecobeeTopic + '/set/hvac')
    health.healthyEvent()
})

client.on('disconnect', () => {
    logging.log('Reconnecting...\n')
    client.connect(host)
    health.unhealthyEvent()
})

client.on('message', (topic, message) => {
    logging.log(' ' + topic + ':' + message)
    var target = '' + message
    if (topic.indexOf('/set/mode')) {
        logging.log('setMode: ' + target)
        setMode(target, function(err, body) {
            logging.log('error:' + err)
            logging.log('body:' + JSON.stringify(body))

            // Only retry once
            handleResponseBody(body, function() {
                logging.log('setMode: ' + target)
                setMode(target, null)
            })
        })
    } else {
        logging.log('setHVACMode: ' + target)
        setHVACMode(target, function(err, body) {
            logging.log('error:' + err)
            logging.log('body:' + JSON.stringify(body))

            // Only retry once
            handleResponseBody(body, function() {
                logging.log('setHVACMode: ' + target)
                setHVACMode(target, null)
            })
        })
    }
})

function handleResponseBody(body, callback) {
    if (body === undefined || body === null) return

    const status = body.status
    if (status === undefined || status === null) return
    const statusCode = status.code
    logging.log('response status code: ' + statusCode)

    switch (statusCode) {
        case 1: // re-auth
        case 2: // re-auth
        case 14: // re-auth

            logging.log(' => kicking re-auth')
            periodicRefresh(callback)
            break
        case 16: // needs new pin
            health.unhealthyEvent()
            setRefreshToken(null)
            setAccessToken(null)

            logging.log(' => news new pin, all is done')
            publishAuthorizationState(0)
            break

        default:
            break
    }
}


function publishAuthorizationState(authState) {
    client.smartPublish(ecobeeTopic + '/authorized', '' + authState)
}

function setRefreshToken(token) {
    if (token === null || token === undefined)
        redis.del('refresh-token')
    else
        redis.set('refresh-token', token)

    health.healthyEvent()
}

function getRefreshToken(callback) {
    redis.get('refresh-token', callback)
}

function setAccessToken(token) {
    if (token === null || token === undefined) {
        redis.del('access-token')
    } else {
        redis.set('access-token', token)
    }

    health.healthyEvent()
}

function getAccessToken(callback) {
    redis.get('access-token', callback)
}

function requestPIN(callback) {
    // GET
    var ecobeeGetPinURL = 'https://api.ecobee.com/authorize?response_type=ecobeePin&client_id=' + ecobeeClientID + '&scope=smartWrite'

    logging.log('queryPinURL: ' + ecobeeGetPinURL)

    request.get({ url: ecobeeGetPinURL, json: true },
        function(err, response, body) {
            if (err !== null && err !== undefined) {
                logging.log('error:' + err)
                logging.log('response:' + response)
                logging.log('body:' + JSON.stringify(body))
            }

            if (callback !== null && callback !== undefined) {
                callback(err, body)
            }
        })
}

function queryRefreshToken(callback) {
    // POST
    getAccessToken(function(err, ecobeeAccessToken) {
        logging.log('ecobeeAccessToken: ' + ecobeeAccessToken)
        var ecobeeGetRefreshTokenURL = 'https://api.ecobee.com/token?grant_type=ecobeePin&code=' + ecobeeAccessToken + '&client_id=' + ecobeeClientID

        logging.log('queryRefreshToken: ' + ecobeeGetRefreshTokenURL)

        request.post({ url: ecobeeGetRefreshTokenURL, json: true },
            function(err, response, body) {
                if (err !== null && err !== undefined) {
                    logging.log('error:' + err)
                    logging.log('response:' + response)
                    logging.log('body:' + JSON.stringify(body))
                }

                if (callback !== null && callback !== undefined) {
                    callback(err, body)
                }
            }).auth(null, null, true, ecobeeAccessToken)
    })
}

function queryAccessToken(callback) {
    // POST
    getRefreshToken(function(err, ecobeeRefreshToken) {
        var ecobeeGetAccessTokenURL = 'https://api.ecobee.com/token?grant_type=refresh_token&code=' + ecobeeRefreshToken + '&client_id=' + ecobeeClientID

        logging.log('queryAccessToken: ' + ecobeeGetAccessTokenURL)

        request.post({ url: ecobeeGetAccessTokenURL, json: true },
            function(err, response, body) {
                if (err !== null && err !== undefined) {
                    logging.log('error:' + err)
                    logging.log('response:' + response)
                    logging.log('body:' + JSON.stringify(body))
                }

                if (callback !== null && callback !== undefined) {
                    callback(err, body)
                }
            }).auth(null, null, true, ecobeeRefreshToken)
    })
}

function queryThermostats(callback) {
    if (waitingForPIN) return

    // POST
    getAccessToken(function(err, ecobeeAccessToken) {
        var ecobeeGetThermostatInfoURL = 'https://api.ecobee.com/1/thermostat?format=json&body=%7B%22selection%22%3A%7B%22includeAlerts%22%3A%22false%22%2C%22selectionType%22%3A%22registered%22%2C%22selectionMatch%22%3A%22%22%2C%22includeEvents%22%3A%22false%22%2C%22includeSettings%22%3A%22false%22%2C%22includeRuntime%22%3A%22true%22%2C%22includeSensors%22%3A%22true%22%2C%22includeExtendedRuntime%22%3A%22true%22%2C%22includeEquipmentStatus%22%3A%22true%22%2C%22includeEvents%22%3A%22true%22%7D%7D'

        logging.log('queryThermostats')

        request.get({ url: ecobeeGetThermostatInfoURL, json: true },
            function(err, response, body) {
                if (err !== null && err !== undefined) {
                    logging.log('error:' + err)
                    logging.log('response:' + response)
                    logging.log('body:' + JSON.stringify(body))
                }

                if (callback !== null && callback !== undefined) {
                    callback(err, body)
                }
            }).auth(null, null, true, ecobeeAccessToken)
    })
}


// auto, cool, heat, off
function setHVACMode(mode, callback) {
    if (waitingForPIN) return

    // POST
    getAccessToken(function(err, ecobeeAccessToken) {
        var ecobeeActionURL = 'https://api.ecobee.com/1/thermostat?format=json'

        logging.log('setHVACMode: ' + mode)

        var postBody = { 'selection': { 'selectionType': 'registered', 'selectionMatch': '' }, 'thermostat': { 'settings': { 'hvacMode': mode } } }

        request.post({ url: ecobeeActionURL, body: postBody, json: true },
            function(err, response, body) {
                if (err !== null && err !== undefined) {
                    logging.log('error:' + err)
                    logging.log('response:' + response)
                    logging.log('body:' + JSON.stringify(body))

                }
                if (callback !== null && callback !== undefined) {
                    callback(err, body)
                }
            }).auth(null, null, true, ecobeeAccessToken)
    })
}

// sleep, home, away
function setMode(mode, callback) {
    if (waitingForPIN) return

    // POST
    getAccessToken(function(err, ecobeeAccessToken) {
        var ecobeeActionURL = 'https://api.ecobee.com/1/thermostat?format=json'

        logging.log('setMode: ' + mode)

        var postBody = { 'selection': { 'selectionType': 'registered', 'selectionMatch': '' }, 'functions': [{ 'type': 'setHold', 'params': { 'holdType': 'indefinite', 'holdClimateRef': mode } }] }

        request.post({ url: ecobeeActionURL, body: postBody, json: true },
            function(err, response, body) {
                if (err !== null && err !== undefined) {
                    logging.log('error:' + err)
                    logging.log('response:' + response)
                    logging.log('body:' + JSON.stringify(body))
                }
                if (callback !== null && callback !== undefined) {
                    callback(err, body)
                }
            }).auth(null, null, true, ecobeeAccessToken)
    })
}

var hasRequestedPIN = false

function periodicRefresh(callback) {
    getRefreshToken(function(err, ecobeeRefreshToken) {
        var hasRefreshToken = ecobeeRefreshToken !== null

        if (hasRefreshToken) {
            logging.log('Refreshing tokens')
            renewTokens(callback)
        }
    })
}

function runLoop() {
    if (waitingForPIN) return
    getAccessToken(function(err, ecobeeAccessToken) {
        getRefreshToken(function(err, ecobeeRefreshToken) {

            var hasAccessToken = ecobeeAccessToken !== null
            var hasRefreshToken = ecobeeRefreshToken !== null

            if (hasAccessToken) {
                logging.log('Has access token')
                publishAuthorizationState(1)
            }

            if (hasRefreshToken) {
                logging.log('Has refresh token')
            }

            if (hasAccessToken) {
                doPoll()
            } else {
                if (!hasRequestedPIN) {
                    hasRequestedPIN = true
                    waitingForPIN = true

                    requestPIN(function(err, body) {
                        const ecobeePin = body.ecobeePin
                        const accessToken = body.code
                        publishAuthorizationState(0)
                        logging.log('')
                        logging.log('============================================================')
                        logging.log('=     Ecobee PIN Setup                                     =')
                        logging.log('=                                                          =')
                        logging.log('=        Ecobee Pin: ' + ecobeePin + '                                  =')
                        logging.log('=                                                          =')
                        logging.log('=        In 60 seconds access token will refresh...        =')
                        logging.log('=                                                          =')
                        logging.log('============================================================')
                        logging.log('')
                        logging.log('')
                        health.healthyEvent()

                        setAccessToken(accessToken)

                        setTimeout(function() {
                            logging.log('... querying tokens')
                            queryRefreshToken(function(err, body) {
                                if (body !== null && body !== undefined) {
                                    const refreshToken = body.refresh_token
                                    const accessToken = body.access_token

                                    logging.log('Loaded tokens - refresh Token: ' + refreshToken + '   access Token: ' + accessToken)
                                    if (refreshToken !== null) {
                                        setRefreshToken(refreshToken)
                                        setAccessToken(accessToken)
                                        health.healthyEvent()
                                        publishAuthorizationState(1)
                                    } else {
                                        logging.log('Failed to authorize')
                                        health.unhealthyEvent()
                                        publishAuthorizationState(0)
                                    }
                                } else if (err !== null && err !== undefined) {
                                    health.unhealthyEvent()
                                    setRefreshToken(null)
                                    setAccessToken(null)
                                    publishAuthorizationState(0)
                                }
                                waitingForPIN = false
                            })
                        }, 60000)
                    })
                }


            }
        })
    })
}

function renewTokens(callback) {
    logging.log('Renewing tokens')

    queryAccessToken(function(err, body) {
        if (body !== null && body !== undefined) {
            const refreshToken = body.refresh_token
            const accessToken = body.access_token

            logging.log('Reloaded tokens - refresh Token: ' + refreshToken + '   access Token: ' + accessToken)

            handleResponseBody(body)

            if (refreshToken !== null && refreshToken !== undefined) {
                setRefreshToken(refreshToken)
                setAccessToken(accessToken)

                if (callback !== null && callback !== undefined) {
                    callback()
                }
            }
            publishAuthorizationState(1)
            health.healthyEvent()
        }

        if (err !== null && err !== undefined) {
            health.unhealthyEvent()
        }
    })

}

function convertToCelsius(value) {
    value = (Number(value) / 10)
    value = f2c(value).toFixed(1)
    return value
}

function doPoll() {
    if (waitingForPIN) return


    getAccessToken(function(err, ecobeeAccessToken) {
        try {
            var hasAccessToken = ecobeeAccessToken !== null


            if (!hasAccessToken) return

            logging.log('polling')

            queryThermostats(function(err, body) {
                logging.log('Loaded thermostats')
                if (err !== null) {
                    logging.log('error:' + err)
                    logging.log('body:' + JSON.stringify(body))
                }

                handleResponseBody(body)

                if (err !== null) {
                    if (
                        err.code === 'ETIMEDOUT' ||
                        err.code === 'ENETUNREACH' ||
                        err.code === 'ECONNREFUSED' ||
                        err.code === 'EADDRNOTAVAIL' ||
                        err.code === 'ELOOP' ||
                        err.code === 'EHOSTUNREACH' ||
                        err.code === 'ENETDOWN' ||
                        err.code === 'EOPNOTSUPP' ||
                        err.code === 'ENAMETOOLONG' ||
                        err.code === 'ECONNRESET' ||
                        err.code === 'EADDRINUSE' ||
                        err.code === 'EACCES' ||
                        err.code === 'ENOENT' ||
                        err.code === 'ECONNREFUSED'
                    ) {
                        health.unhealthyEvent()
                        logging.log('request error:' + err)
                        return
                    }

                } else if (err !== null) {
                    logging.log('Thermostat query failed')
                } else if (body !== null) {
                    logging.log('Loading done:' + JSON.stringify(body))
                    const thermostatList = body.thermostatList
                    logging.log('thermostatList:' + thermostatList)
                    if (thermostatList === null || thermostatList === undefined) {
                        return
                    }

                    health.healthyEvent()
                    const thermostat = thermostatList[0]
                    const thermostatName = thermostat.name
                    const events = thermostat.events[0]
                    const runtime = thermostat.runtime
                    const mode = events.holdClimateRef
                    const fan = events.fan
                    const remoteSensors = thermostat.remoteSensors

                    logging.log('thermostatName:' + thermostatName)
                    logging.log('runtime: ' + JSON.stringify(runtime))

                    logging.log('mode:' + mode)
                    logging.log('fan:' + fan)


                    const thermostatTemperature = convertToCelsius(runtime.actualTemperature)
                    const thermostatHumidity = runtime.actualHumidity
                    const connected = runtime.connected
                    const desiredHeat = convertToCelsius(runtime.desiredHeat)
                    const desiredCool = convertToCelsius(runtime.desiredCool)
                    const targetTemperature = (Number(desiredHeat) + Number(((desiredCool - desiredHeat) / 2.0)))
                    const currentMode = runtime.desiredFanMode

                    logging.log('thermostatTemperature:' + thermostatTemperature)
                    logging.log('thermostatHumidity:' + thermostatHumidity)
                    logging.log('connected:' + connected)
                    logging.log('desiredHeat:' + desiredHeat)
                    logging.log('desiredCool:' + desiredCool)
                    logging.log('targetTemperature:' + targetTemperature)
                    logging.log('currentMode:' + currentMode)

                    logging.log('remoteSensors:' + remoteSensors)

                    client.smartPublish(ecobeeTopic + '/home/target_temperature', '' + targetTemperature)
                    client.smartPublish(ecobeeTopic + '/home/connected', '' + connected)
                    client.smartPublish(ecobeeTopic + '/home/desiredHeat', '' + desiredHeat)
                    client.smartPublish(ecobeeTopic + '/home/desiredCool', '' + desiredCool)
                    client.smartPublish(ecobeeTopic + '/home/mode', '' + currentMode)

                    remoteSensors.forEach(function(sensor) {
                        const sensorName = sensor.name
                        const capabilities = sensor.capability
                        capabilities.forEach(function(capability) {
                            const type = capability.type
                            var value = capability.value

                            if (type === 'temperature') {
                                value = convertToCelsius(value)
                            }

                            logging.log('   name:' + sensorName + ' type: ' + type + '    value: ' + value)
                            client.smartPublish(ecobeeTopic + '/' + type + '/' + sensorName, '' + value)
                        }, this)
                    }, this)

                }
            })
        } catch (error) {
            logging.log('   **** caught error during poll: ' + error)
        }
    })
}


repeat(runLoop).every(30, 's').start.in(5, 'sec')