// Requirements
const mqtt = require('mqtt')
const logging = require('homeautomation-js-lib/logging.js')
const health = require('homeautomation-js-lib/health.js')
const repeat = require('repeat')
const request = require('request')
const _ = require('lodash')
const f2c = require('fahrenheit-to-celsius')
const Redis = require('redis')

require('homeautomation-js-lib/mqtt_helpers.js')
require('homeautomation-js-lib/redis_helpers.js')

const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT
const redisDB = process.env.REDIS_DATABASE

if (_.isNil(redisHost) || _.isNil(redisPort) || _.isNil(redisDB)) {
    logging.warn('Environment variable REDIS_HOST, REDIS_PORT, or REDIS_DATABASE missing, aborting')
    process.abort()
}

// create a Configstore instance with an unique ID e.g.
// Package name and optionally some default values

const ecobeeTopic = process.env.ECOBEE_TOPIC
const ecobeeClientID = process.env.ECOBEE_CLIENT_ID

const healthCheckPort = process.env.HEALTH_CHECK_PORT
const healthCheckTime = process.env.HEALTH_CHECK_TIME
const healthCheckURL = process.env.HEALTH_CHECK_URL

if (!_.isNil(healthCheckPort) && !_.isNil(healthCheckTime) && !_.isNil(healthCheckURL)) {
    health.startHealthChecks(healthCheckURL, healthCheckPort, healthCheckTime)
}
repeat(runLoop).every(30, 's').start.in(5, 'sec')

// Setup MQTT
var client = mqtt.setupClient(
    function() {
        const topics = [ecobeeTopic + '/mode/set', ecobeeTopic + '/hvac/set']
        logging.info('Connected, subscribing ')
        topics.forEach(function(topic) {
            logging.info(' => Subscribing to: ' + topic)
            client.subscribe(topic)
        }, this)


        health.healthyEvent()
    },
    function() {
        health.unhealthyEvent()
    }
)

var waitingForPIN = false

const redis = Redis.setupClient(null)
logging.info('redis: ' + redis)

client.on('message', (topic, message) => {
    if (redis.connected === false) {
        logging.error('redis is not connected')
        return
    }
    logging.info(' ' + topic + ':' + message, { topic: topic, value: message })
    logging.info(' ' + topic + ':' + message, { topic: topic, value: message })
    var target = '' + message
    if (topic.indexOf('/mode/set') >= 0) {
        logging.info('setMode: ' + target, { action: 'setmode', value: target })
        setMode(target, function(err, body) {
            logging.info('error:' + err, { error: err })
            logging.info('body:' + JSON.stringify(body))
            logging.info('setMode: ' + target, { action: 'setmode', result: 'success' })

            // Only retry once
            handleResponseBody(body, function() {
                logging.info('setMode: ' + target)
                setMode(target, null)
            })
        })
    } else {
        logging.info('setHVACMode: ' + target, { action: 'sethvacmode', result: target })
        setHVACMode(target, function(err, body) {
            logging.info('error:' + err)
            logging.info('body:' + JSON.stringify(body))

            // Only retry once
            handleResponseBody(body, function() {
                logging.info('setHVACMode: ' + target)
                setHVACMode(target, null)
            })
        })
    }
})

function handleResponseBody(body, callback) {
    logging.info('handleResponseBody')
    if (_.isNil(body)) return

    const status = body.status
    if (_.isNil(status)) return
    const statusCode = status.code
    logging.info('response status code: ' + statusCode, { 'response-code': statusCode })

    switch (statusCode) {
        case 1: // re-auth
        case 2: // re-auth
        case 14: // re-auth

            logging.info(' => kicking re-auth', { action: 're-authenticate' })
            periodicRefresh(callback)
            break
        case 16: // needs new pin
            health.unhealthyEvent()
            setRefreshToken(null)
            setAccessToken(null)

            logging.info(' => news new pin, all is done', { action: 'new-pin-request' })
            publishAuthorizationState(0)
            break

        default:
            break
    }
}


function publishAuthorizationState(authState) {
    logging.info('publishAuthorizationState')
    client.smartPublish(ecobeeTopic + '/authorized', '' + authState)
}

function setRefreshToken(token) {
    logging.info('setRefreshToken')
    if (_.isNil(token))
        redis.del('refresh-token')
    else
        redis.set('refresh-token', token)

    health.healthyEvent()
}

function getRefreshToken(callback) {
    logging.info('getRefreshToken')
    redis.get('refresh-token', callback)
}

function setAccessToken(token) {
    logging.info('setAccessToken')
    if (_.isNil(token)) {
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

    logging.info('queryPinURL: ' + ecobeeGetPinURL, { action: 'request-pin' })

    request.get({ url: ecobeeGetPinURL, json: true },
        function(err, response, body) {
            if (!_.isNil(err)) {
                logging.info('error:' + err)
                logging.info('response:' + response)
                logging.info('body:' + JSON.stringify(body))
            }

            if (!_.isNil(callback)) {
                callback(err, body)
            }
        })
}

function queryRefreshToken(callback) {
    // POST
    getAccessToken(function(err, ecobeeAccessToken) {
        logging.info('ecobeeAccessToken: ' + ecobeeAccessToken)
        var ecobeeGetRefreshTokenURL = 'https://api.ecobee.com/token?grant_type=ecobeePin&code=' + ecobeeAccessToken + '&client_id=' + ecobeeClientID

        logging.info('queryRefreshToken: ' + ecobeeGetRefreshTokenURL, { action: 'get-refresh-token' })

        request.post({ url: ecobeeGetRefreshTokenURL, json: true },
            function(err, response, body) {
                if (!_.isNil(err)) {
                    logging.info('error:' + err)
                    logging.info('response:' + response)
                    logging.info('body:' + JSON.stringify(body))
                }

                if (!_.isNil(callback)) {
                    callback(err, body)
                }
            }).auth(null, null, true, ecobeeAccessToken)
    })
}

function queryAccessToken(callback) {
    // POST
    getRefreshToken(function(err, ecobeeRefreshToken) {
        var ecobeeGetAccessTokenURL = 'https://api.ecobee.com/token?grant_type=refresh_token&code=' + ecobeeRefreshToken + '&client_id=' + ecobeeClientID

        logging.info('queryAccessToken: ' + ecobeeGetAccessTokenURL, { action: 'get-access-token' })

        request.post({ url: ecobeeGetAccessTokenURL, json: true },
            function(err, response, body) {
                if (!_.isNil(err)) {
                    logging.info('error:' + err)
                    logging.info('response:' + response)
                    logging.info('body:' + JSON.stringify(body))
                }

                if (!_.isNil(callback)) {
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

        logging.info('queryThermostats', { action: 'thermostat-info' })

        request.get({ url: ecobeeGetThermostatInfoURL, json: true },
            function(err, response, body) {
                if (!_.isNil(err)) {
                    logging.info('error:' + err)
                    logging.info('response:' + response)
                    logging.info('body:' + JSON.stringify(body))
                }

                if (!_.isNil(callback)) {
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

        logging.info('setHVACMode: ' + mode)

        var postBody = { 'selection': { 'selectionType': 'registered', 'selectionMatch': '' }, 'thermostat': { 'settings': { 'hvacMode': mode } } }

        request.post({ url: ecobeeActionURL, body: postBody, json: true },
            function(err, response, body) {
                if (!_.isNil(err)) {
                    logging.info('error:' + err)
                    logging.info('response:' + response)
                    logging.info('body:' + JSON.stringify(body))

                }
                if (!_.isNil(callback)) {
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

        logging.info('setMode: ' + mode)

        var postBody = { 'selection': { 'selectionType': 'registered', 'selectionMatch': '' }, 'functions': [{ 'type': 'setHold', 'params': { 'holdType': 'indefinite', 'holdClimateRef': mode } }] }

        request.post({ url: ecobeeActionURL, body: postBody, json: true },
            function(err, response, body) {
                if (!_.isNil(err)) {
                    logging.info('error:' + err)
                    logging.info('response:' + response)
                    logging.info('body:' + JSON.stringify(body))
                }
                if (!_.isNil(callback)) {
                    callback(err, body)
                }
            }).auth(null, null, true, ecobeeAccessToken)
    })
}

var hasRequestedPIN = false

function periodicRefresh(callback) {
    getRefreshToken(function(err, ecobeeRefreshToken) {
        var hasRefreshToken = !_.isNil(ecobeeRefreshToken)

        if (hasRefreshToken) {
            logging.info('Refreshing tokens')
            renewTokens(callback)
        } else {
            setAccessToken(null)
            logging.info('missing refresh token')

        }
    })
}

function runLoop() {
    if (redis.connected === false) {
        logging.error('redis is not connected')
        return
    }
    if (waitingForPIN) return

    getAccessToken(function(err, ecobeeAccessToken) {
        getRefreshToken(function(err, ecobeeRefreshToken) {

            var hasAccessToken = !_.isNil(ecobeeAccessToken)
            var hasRefreshToken = !_.isNil(ecobeeRefreshToken)

            if (hasAccessToken) {
                logging.info('Has access token')
                publishAuthorizationState(1)
            }

            if (hasRefreshToken) {
                logging.info('Has refresh token')
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
                        logging.info('')
                        logging.info('============================================================')
                        logging.info('=     Ecobee PIN Setup                                     =')
                        logging.info('=                                                          =')
                        logging.info('=        Ecobee Pin: ' + ecobeePin + '                                  =')
                        logging.info('=                                                          =')
                        logging.info('=        In 60 seconds access token will refresh...        =')
                        logging.info('=                                                          =')
                        logging.info('============================================================')
                        logging.info('')
                        logging.info('')
                        health.healthyEvent()

                        setAccessToken(accessToken)

                        setTimeout(function() {
                            logging.info('... querying tokens')
                            queryRefreshToken(function(err, body) {
                                if (!_.isNil(body)) {
                                    const refreshToken = body.refresh_token
                                    const accessToken = body.access_token

                                    logging.info('Loaded tokens', { 'access-token': accessToken, 'refresh-token': refreshToken })
                                    if (!_.isNil(refreshToken)) {
                                        setRefreshToken(refreshToken)
                                        setAccessToken(accessToken)
                                        health.healthyEvent()
                                        publishAuthorizationState(1)
                                    } else {
                                        logging.error('Failed to authorize')
                                        health.unhealthyEvent()
                                        publishAuthorizationState(0)
                                    }
                                } else if (!_.isNil(err)) {
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
    logging.info('Renewing tokens')

    queryAccessToken(function(err, body) {
        if (!_.isNil(body)) {
            const refreshToken = body.refresh_token
            const accessToken = body.access_token

            logging.info('Reloaded tokens', { 'access-token': accessToken, 'refresh-token': refreshToken })

            handleResponseBody(body)

            if (!_.isNil(refreshToken)) {
                setRefreshToken(refreshToken)
                setAccessToken(accessToken)

                if (!_.isNil(callback)) {
                    callback()
                }
            } else {
                setRefreshToken(null)
                setAccessToken(null)
            }
            publishAuthorizationState(1)
            health.healthyEvent()
        }

        if (!_.isNil(err)) {
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
    if (redis.connected === false) {
        logging.info('redis is not connected, not polling')
        return
    }

    if (waitingForPIN) return

    getAccessToken(function(err, ecobeeAccessToken) {
        try {
            var hasAccessToken = !_.isNil(ecobeeAccessToken)

            if (!hasAccessToken) return

            logging.info('polling')

            queryThermostats(function(err, body) {
                logging.info('Loaded thermostats')
                if (!_.isNil(err)) {
                    logging.info('error:' + err)
                    logging.info('body:' + JSON.stringify(body))
                }

                handleResponseBody(body)

                if (!_.isNil(err)) {
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
                        logging.error('request error:' + err)
                        return
                    }

                } else if (!_.isNil(err)) {
                    logging.error('Thermostat query failed')
                } else if (!_.isNil(body)) {
                    logging.info('Loading done:' + JSON.stringify(body))
                    const thermostatList = body.thermostatList
                    logging.info('thermostatList:' + thermostatList)
                    if (_.isNil(thermostatList)) {
                        return
                    }

                    health.healthyEvent()
                    const thermostat = thermostatList[0]
                    const thermostatName = thermostat.name
                    const events = thermostat.events[0]
                    const runtime = thermostat.runtime
                    const mode = _.isNil(events) ? 'schedule' : events.holdClimateRef
                    const remoteSensors = thermostat.remoteSensors

                    const thermostatTemperature = convertToCelsius(runtime.actualTemperature)
                    const thermostatHumidity = runtime.actualHumidity
                    const connected = runtime.connected
                    const desiredHeat = convertToCelsius(runtime.desiredHeat)
                    const desiredCool = convertToCelsius(runtime.desiredCool)
                    const targetTemperature = (Number(desiredHeat) + Number(((desiredCool - desiredHeat) / 2.0)))
                    const currentMode = runtime.desiredFanMode

                    logging.info('thermostat update', {
                        event: 'thermostat-update',
                        name: thermostatName,
                        runtime: runtime,
                        mode: mode,
                        desiredHeat: desiredHeat,
                        desiredCool: desiredCool,
                        connected: connected,
                        temperature: thermostatTemperature,
                        humidity: thermostatHumidity,
                        'target-temperature': targetTemperature,
                        fan: currentMode
                    })


                    client.smartPublish(ecobeeTopic + '/home/target_temperature', '' + targetTemperature)
                    client.smartPublish(ecobeeTopic + '/home/connected', '' + connected)
                    client.smartPublish(ecobeeTopic + '/home/desiredHeat', '' + desiredHeat)
                    client.smartPublish(ecobeeTopic + '/home/desiredCool', '' + desiredCool)
                    client.smartPublish(ecobeeTopic + '/home/mode', '' + currentMode)

                    remoteSensors.forEach(function(sensor) {
                        const sensorName = sensor.name
                        const capabilities = sensor.capability
                        var newCaps = {}
                        capabilities.forEach(function(capability) {
                            const type = capability.type
                            var value = capability.value

                            if (type === 'temperature') {
                                value = convertToCelsius(value)
                            }

                            newCaps[type] = value
                            client.smartPublish(ecobeeTopic + '/' + type + '/' + sensorName, '' + value)
                        }, this)
                        newCaps['name'] = sensorName
                        newCaps['event'] = 'sensor-update'
                        logging.info('   sensor update', newCaps)
                    }, this)
                }
            })
        } catch (error) {
            logging.error('   **** caught error during poll: ' + error, { error: '' + error })
        }
    })
}