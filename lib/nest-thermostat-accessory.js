/**
 * Created by kraigm on 12/15/15.
 */

'use strict';

const { NestDeviceAccessory, Service, Characteristic, hap } = require('./nest-device-accessory')();

const nestDeviceDescriptor = {
    deviceType: 'thermostat',
    deviceGroup: 'thermostats',
    deviceDesc: 'Nest Thermostat'
};

class NestThermostatAccessory extends NestDeviceAccessory {
    constructor(conn, log, device, structure, platform) {
        super(conn, log, device, structure, platform);

        this.isZirconium = (this.device.protobuf_device_type == 'google.resource.GoogleZirconium1Resource');

        const thermostatService = this.addService(Service.Thermostat);

        const formatCurrentHeatingCoolingState = function (val) {
            switch (val) {
            case Characteristic.CurrentHeatingCoolingState.OFF:
                return 'Off';
            case Characteristic.CurrentHeatingCoolingState.HEAT:
                return 'Heating';
            case Characteristic.CurrentHeatingCoolingState.COOL:
                return 'Cooling';
            }
        };

        const formatTargetHeatingCoolingState = function (val) {
            switch (val) {
            case Characteristic.TargetHeatingCoolingState.OFF:
                return 'Off';
            case Characteristic.TargetHeatingCoolingState.HEAT:
                return 'Heat';
            case Characteristic.TargetHeatingCoolingState.COOL:
                return 'Cool';
            case Characteristic.TargetHeatingCoolingState.AUTO:
                return 'Auto';
            }
        };

        const bindCharacteristic = function (characteristic, desc, getFunc, setFunc, format) {
            this.bindCharacteristic(thermostatService, characteristic, desc, getFunc, setFunc, format);
        }.bind(this);

        bindCharacteristic(Characteristic.TemperatureDisplayUnits, 'Temperature unit', this.getTemperatureUnits, this.setTemperatureUnits, function (val) {
            return val == Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? 'Fahrenheit' : 'Celsius';
        });

        bindCharacteristic(Characteristic.CurrentTemperature, 'Current temperature', this.getCurrentTemperature, null, this.formatAsDisplayTemperature);
        bindCharacteristic(Characteristic.CurrentHeatingCoolingState, 'Current heating/cooling state', this.getCurrentHeatingCooling, null, formatCurrentHeatingCoolingState);
        bindCharacteristic(Characteristic.CurrentRelativeHumidity, 'Current humidity', this.getCurrentRelativeHumidity, null, function(val) {
            return val + '%';
        });

        /*
       * Only allow 0.5 increments for Celsius temperatures. HomeKit is already limited to 1-degree increments in Fahrenheit,
       * and setting this value for Fahrenheit will cause HomeKit to incorrectly round values when converting from °F to °C and back.
       */
        let minSetTemp, maxSetTemp, minGetTemp, maxGetTemp;
        this.tempStep = 0.1;
        if (this.usesFahrenheit()) {
            minSetTemp = this.fahrenheitToCelsius(50);
            maxSetTemp = this.fahrenheitToCelsius(90);
            minGetTemp = this.fahrenheitToCelsius(0);
            maxGetTemp = this.fahrenheitToCelsius(160);
        } else {
            minSetTemp = 9;
            maxSetTemp = 32;
            minGetTemp = -20;
            maxGetTemp = 60;
        }

        thermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minStep: this.tempStep, minValue: minGetTemp, maxValue: maxGetTemp });
        thermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({ minStep: this.tempStep, minValue: minSetTemp, maxValue: maxSetTemp });
        thermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({ minStep: this.tempStep, minValue: minSetTemp, maxValue: maxSetTemp });
        thermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({ minStep: this.tempStep, minValue: minSetTemp, maxValue: maxSetTemp });

        if (!this.device.can_cool) {
            thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
        } else if (!this.device.can_heat) {
            thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
        } else {
            thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL, Characteristic.TargetHeatingCoolingState.AUTO]});
        }

        bindCharacteristic(Characteristic.TargetTemperature, 'Target temperature', this.getTargetTemperature, this.setTargetTemperature, this.formatAsDisplayTemperature);
        bindCharacteristic(Characteristic.TargetHeatingCoolingState, 'Target heating/cooling state', this.getTargetHeatingCooling, this.setTargetHeatingCooling, formatTargetHeatingCoolingState);

        bindCharacteristic(Characteristic.CoolingThresholdTemperature, 'Cooling threshold temperature', this.getCoolingThresholdTemperature, this.setCoolingThresholdTemperature, this.formatAsDisplayTemperature);
        bindCharacteristic(Characteristic.HeatingThresholdTemperature, 'Heating threshold temperature', this.getHeatingThresholdTemperature, this.setHeatingThresholdTemperature, this.formatAsDisplayTemperature);

        if (this.device.has_fan && !this.platform.optionSet('Thermostat.Fan.Disable', this.device.serial_number, this.device.device_id)) {
            const thermostatFanService = this.addService(Service.Fan, 'Fan', 'fan.' + this.device.serial_number);
            const formatFanState = function (val) {
                return val ? 'On' : 'Off';
            };
            this.bindCharacteristic(thermostatFanService, Characteristic.On, 'Fan State', this.getFanState, this.setFanState, formatFanState);
        }

        thermostatService.addOptionalCharacteristic(Characteristic.StatusActive);
        bindCharacteristic(Characteristic.StatusActive, 'Online status', this.getOnlineStatus);

        if (!this.isZirconium && this.device.has_eco_mode && !this.platform.optionSet('Thermostat.Eco.Disable', this.device.serial_number, this.device.device_id)) {
            const thermostatEcoModeService = this.addService(Service.Switch, 'Eco Mode', 'eco_mode.' + this.device.serial_number);
            this.bindCharacteristic(thermostatEcoModeService, Characteristic.On, 'Eco Mode', this.getEcoMode, this.setEcoMode);
        }

        if (this.device.has_hot_water_control && !this.platform.optionSet('Thermostat.HotWater.Disable', this.device.serial_number, this.device.device_id)) {
            const hotWaterService = this.addService(Service.Switch, 'Hot Water', 'hot_water.' + this.device.serial_number);
            this.bindCharacteristic(hotWaterService, Characteristic.On, 'Hot Water', this.getHotWaterState, this.setHotWaterState);
        }

        if (this.device.has_temperature_sensors || this.platform.optionSet('Thermostat.SeparateBuiltInTemperatureSensor.Enable', this.device.serial_number, this.device.device_id)) {
            const tempService = this.addService(Service.TemperatureSensor, this.homeKitSanitize(this.device.where_name + ' Temperature'), 'temp-sensor.' + this.device.serial_number);

            if (this.platform.optionSet('Thermostat.UseActiveTempSensorAsThermostatTemperature.Enable', this.device.serial_number, this.device.device_id)) {
                this.bindCharacteristic(tempService, Characteristic.CurrentTemperature, 'Temperature', this.getCurrentTemperature, null, this.formatAsDisplayTemperature);
            } else {
                this.bindCharacteristic(tempService, Characteristic.CurrentTemperature, 'Temperature', this.getBackplateTemperature, null, this.formatAsDisplayTemperature);
            }
            tempService.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minStep: this.tempStep, minValue: minGetTemp, maxValue: maxGetTemp });
        }

        if (this.platform.optionSet('Thermostat.SeparateBuiltInHumiditySensor.Enable', this.device.serial_number, this.device.device_id)) {
            const humService = this.addService(Service.HumiditySensor, this.homeKitSanitize(this.device.where_name + ' Humidity'), 'humidity-sensor.' + this.device.serial_number);
            this.bindCharacteristic(humService, Characteristic.CurrentRelativeHumidity, 'Humidity', this.getCurrentRelativeHumidity);
        }

        // Add custom characteristics

        if (this.device.has_fan === true) { // legacy: now exposed as a Fan
            this.addFanTimerActiveCharacteristic(thermostatService);
            this.addFanTimerDurationCharacteristic(thermostatService);
        }

        this.addHasLeafCharacteristic(thermostatService);
        this.addSunlightCorrectionEnabledCharacteristic(thermostatService);
        this.addSunlightCorrectionActiveCharacteristic(thermostatService);
        this.addUsingEmergencyHeatCharacteristic(thermostatService);

        this.fanOffOverride = false;
        this.fanOffOverrideTimer = null;

        this.updateData();
    }

    usesFahrenheit() {
        return this.getTemperatureUnits() === Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    }

    getCurrentHeatingCooling() {
        switch (this.device.hvac_state) {
        case 'heating':
            return Characteristic.CurrentHeatingCoolingState.HEAT;
        case 'cooling':
            return Characteristic.CurrentHeatingCoolingState.COOL;
        case 'off':
        default:
            return Characteristic.CurrentHeatingCoolingState.OFF;
        }
    }

    getTargetHeatingCooling() {
        let mode = (this.isZirconium && this.device.hvac_mode == 'eco') ? this.device.previous_hvac_mode : this.device.hvac_mode;

        switch (mode) {
        case 'heat':
            return Characteristic.TargetHeatingCoolingState.HEAT;
        case 'cool':
            return Characteristic.TargetHeatingCoolingState.COOL;
        case 'range':
            return Characteristic.TargetHeatingCoolingState.AUTO;
        case 'eco':
            if (this.device.away_temperature_high_enabled && this.device.away_temperature_low_enabled) {
                return Characteristic.TargetHeatingCoolingState.AUTO;
            } else if (this.device.away_temperature_low_enabled) {
                return Characteristic.TargetHeatingCoolingState.HEAT;
            } else if (this.device.away_temperature_high_enabled) {
                return Characteristic.TargetHeatingCoolingState.COOL;
            } else {
                return Characteristic.TargetHeatingCoolingState.OFF;
            }
        case 'off':
        default:
            return Characteristic.TargetHeatingCoolingState.OFF;
        }
    }

    getCurrentTemperature() {
        return this.unroundTemperature(this.device.current_temperature || this.device.backplate_temperature);
    }

    getBackplateTemperature() {
        return this.unroundTemperature(this.device.backplate_temperature || this.device.current_temperature);
    }

    getCurrentRelativeHumidity() {
        return this.device.current_humidity;
    }

    // Siri will use this even when in AUTO mode
    getTargetTemperature() {
        let mode = (this.isZirconium && this.device.hvac_mode == 'eco') ? this.device.previous_hvac_mode : this.device.hvac_mode;

        this.conn.verbose('getTargetTemperature', this.device.hvac_mode, this.device.hvac_state, this.device.target_temperature);
        switch (mode) {
        case 'eco':
            if (this.device.away_temperature_low_enabled && !this.device.away_temperature_high_enabled) {
                return this.getHeatingThresholdTemperature();
            } else if (this.device.away_temperature_high_enabled && !this.device.away_temperature_low_enabled) {
                return this.getCoolingThresholdTemperature();
            } else {
                return this.getCurrentTemperature();
            }
        case 'off':
            return this.getCurrentTemperature();
        default:
            return this.unroundTemperature(this.device.target_temperature);
        }
    }

    getCoolingThresholdTemperature() {
        if (this.isZirconium || this.device.hvac_mode != 'eco') {
            return this.unroundTemperature(this.device.target_temperature_high || this.device.target_temperature);
        }
        return this.unroundTemperature(this.device.eco_temperature_high || this.device.away_temperature_high);
    }

    getHeatingThresholdTemperature() {
        if (this.isZirconium || this.device.hvac_mode != 'eco') {
            return this.unroundTemperature(this.device.target_temperature_low || this.device.target_temperature);
        }
        return this.unroundTemperature(this.device.eco_temperature_low || this.device.away_temperature_low);
    }

    getTemperatureUnits() {
        switch (this.device.temperature_scale) {
        case 'F':
            return Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
        case 'C':
        default:
            return Characteristic.TemperatureDisplayUnits.CELSIUS;
        }
    }

    setTemperatureUnits(temperatureUnits, callback) {
        let val;

        switch (temperatureUnits) {
        case Characteristic.TemperatureDisplayUnits.FAHRENHEIT:
            val = 'F';
            break;
        case Characteristic.TemperatureDisplayUnits.CELSIUS:
        default:
            val = 'C';
            break;
        }

        this.setPropertyAsync('device', 'temperature_scale', val, 'temperature display units')
            .asCallback(callback);
    }

    setTargetHeatingCooling(targetHeatingCooling, callback) {
        let val = 'off';

        switch (targetHeatingCooling) {
        case Characteristic.TargetHeatingCoolingState.HEAT:
            val = 'heat';
            break;
        case Characteristic.TargetHeatingCoolingState.COOL:
            val = 'cool';
            break;
        case Characteristic.TargetHeatingCoolingState.AUTO:
            val = (this.device.can_heat && this.device.can_cool) ? 'range' : this.device.can_cool ? 'cool' : 'heat';
            break;
        case Characteristic.TargetHeatingCoolingState.OFF:
        default:
            break;
        }

        if (this.getTargetHeatingCooling() == targetHeatingCooling) {
            // Workaround for iOS 13 issue with Eco Mode spontaneously switching back to Heat-Cool
            return void callback();
        }

        this.conn.verbose('setTargetHeatingCooling', val);
        this.device.target_temperature_type = val;
        
        // Store the HomeKit state for AUTO mode even if we're going to intercept it
        if (targetHeatingCooling === Characteristic.TargetHeatingCoolingState.AUTO) {
            this.homekitAutoMode = true;
        } else {
            this.homekitAutoMode = false;
        }
        
        // If it's AUTO mode and too cold outside, don't send to Nest API
        // Just update the local state and run the fan if needed
        if (val === 'range' && this.isTooColdToRunAC()) {
            this.log.info('AUTO mode requested but too cold outside. Showing AUTO in HomeKit but not sending to Nest API.');
            
            // Update local state
            this.device.hvac_mode = val;
            
            // Run the fan if it's warm enough inside to need cooling
            const currentTemp = this.getCurrentTemperature();
            const targetHighTemp = this.getTargetHeatingCoolingMaxTemperature();
            
            if (currentTemp > targetHighTemp) {
                this.log.info('Running fan instead of cooling in AUTO mode.');
                this.runFanInstead();
            }
            
            callback();
            return;
        }
        
        this.setPropertyAsync('shared', 'hvac_mode', val, 'target heating cooling').asCallback(callback);
    }

    // Helper method to run the fan
    runFanInstead() {
        // Run the fan instead
        this.fanOnOverride = true;
        if (this.fanOnOverrideTimer) {
            clearTimeout(this.fanOnOverrideTimer);
            this.fanOnOverrideTimer = null;
        }
        
        // Keep the fan running until the cooling request would normally end
        // For now, we'll use a longer timer than the standard fan timer
        this.fanOnOverrideTimer = setTimeout(() => { 
            this.fanOnOverrideTimer = null; 
            this.fanOnOverride = false; 
        }, 30 * 60 * 1000); // 30 minutes
    }

    setPropertyAsync(type, property, value, propertyDescription, valueDescription, doNotUpdateLocalProperty) {
        // Check if this is a cooling command and it's too cold outside
        if (type === 'shared' && property === 'hvac_mode' && 
            (value === 'cool' || value === 'range') && this.isTooColdToRunAC()) {
            
            // For range mode (AUTO), we'll completely intercept it
            if (value === 'range') {
                this.log.info('AUTO mode requested but too cold outside. Not sending to Nest API.');
                
                // Don't send the command to the Nest API
                if (!doNotUpdateLocalProperty) {
                    this.device[property] = value;
                }
                
                // Return a resolved promise to simulate success
                return Promise.resolve(true);
            }
            
            // For cool mode, run the fan instead
            this.log.info('Too cold outside to run AC. Running fan instead.');
            
            // Don't send the cooling command to the Nest API
            if (!doNotUpdateLocalProperty) {
                this.device[property] = value;
            }
            
            // Run the fan
            this.runFanInstead();
            
            // Return a resolved promise to simulate success
            return Promise.resolve(true);
        }
        
        // For all other cases, call the parent method
        return super.setPropertyAsync(type, property, value, propertyDescription, valueDescription, doNotUpdateLocalProperty);
    }

    getFanState() {
        if (this.fanOffOverride) {
            return false;
        } else if (this.fanOnOverride) {
            return true;
        } else {
            return this.device.hvac_fan_state;
            // return this.device.fan_timer_active || this.device.fan_timer_timeout > 0;
        }
    }

    setFanState(targetFanState, callback) {
        if (this.fanOnOverrideTimer) {
            clearTimeout(this.fanOnOverrideTimer);
            this.fanOnOverrideTimer = null;
        }
        if (this.fanOffOverrideTimer) {
            clearTimeout(this.fanOffOverrideTimer);
            this.fanOffOverrideTimer = null;
        }
        this.fanOnOverride = targetFanState;
        this.fanOffOverride = !targetFanState;
        if (!targetFanState) {
            this.fanOffOverrideTimer = setTimeout(() => { this.fanOffOverrideTimer = null; this.fanOffOverride = false; }, 45000);
        } else {
            this.fanOnOverrideTimer = setTimeout(() => { this.fanOnOverrideTimer = null; this.fanOnOverride = false; }, 8000);
        }
        this.log('Setting target fan state for ' + this.name + ' to: ' + targetFanState);
        this.setPropertyAsync('device', 'fan_timer_active', Boolean(targetFanState), 'fan enable/disable').asCallback(callback);
    }

    getHotWaterState() {
        return this.device.hot_water_active || (this.device.hot_water_boost_time_to_end > 0);
    }

    setHotWaterState(targetHotWaterState, callback) {
        this.log('Setting hot water state for ' + this.name + ' to: ' + targetHotWaterState);
        this.setPropertyAsync('device', 'hot_water_active', Boolean(targetHotWaterState), 'hot water enable/disable').asCallback(callback);
    }

    getEcoMode() {
        return (this.device.hvac_mode === 'eco');
    }

    setEcoMode(eco, callback) {
        const val = eco ? 'eco' : this.device.previous_hvac_mode;
        this.log.info('Setting Eco Mode for ' + this.name + ' to: ' + val);
        this.device.hvac_mode = val;
        this.setPropertyAsync('shared', 'hvac_mode', eco ? 'eco' : 'eco-off', 'target heating cooling', null, true).asCallback(callback);
    }

    formatAsDisplayTemperature(t) {
        let precision = 0.001;
        return (precision * Math.round(t / precision)) + ' °C / ' + (precision * Math.round(this.celsiusToFahrenheit(t) / precision)) + ' °F';
    }

    addFanTimerActiveCharacteristic(service) {
        service.addCharacteristic(FanTimerActive);
        this.bindCharacteristic(service, FanTimerActive, 'Fan Timer Active', this.isFanTimerActive);
    }

    addFanTimerDurationCharacteristic(service) {
        service.addCharacteristic(FanTimerDuration);
        this.bindCharacteristic(service, FanTimerDuration, 'Fan Timer Duration', this.getFanTimerDuration);
    }

    addHasLeafCharacteristic(service) {
        service.addCharacteristic(HasLeaf);
        this.bindCharacteristic(service, HasLeaf, 'Has Leaf', this.isHasLeaf);
    }

    addSunlightCorrectionEnabledCharacteristic(service) {
        service.addCharacteristic(SunlightCorrectionEnabled);
        this.bindCharacteristic(service, SunlightCorrectionEnabled, 'Sunlight Correction Enabled', this.isSunlightCorrectionEnabled);
    }

    addSunlightCorrectionActiveCharacteristic(service) {
        service.addCharacteristic(SunlightCorrectionActive);
        this.bindCharacteristic(service, SunlightCorrectionActive, 'Sunlight Correction Active', this.isSunlightCorrectionActive);
    }

    addUsingEmergencyHeatCharacteristic(service) {
        service.addCharacteristic(UsingEmergencyHeat);
        this.bindCharacteristic(service, UsingEmergencyHeat, 'Using Emergency Heat', this.isUsingEmergencyHeat);
    }

    isFanTimerActive() {
        return this.device.fan_timer_active;
    }

    getFanTimerDuration() {
        return Math.round(this.device.fan_timer_duration / 60);
    }

    isHasLeaf() {
        return this.device.has_leaf || false;
    }

    isSunlightCorrectionEnabled() {
        return this.device.sunlight_correction_enabled || false;
    }

    isSunlightCorrectionActive() {
        return this.device.sunlight_correction_active || false;
    }

    isUsingEmergencyHeat() {
        return this.device.is_using_emergency_heat || false;
    }

    getOnlineStatus() {
        return this.device.is_online;
    }

    // Check if it's too cold outside to run the AC
    isTooColdToRunAC() {
        // Get the outdoor temperature - this could be from a weather API or a local sensor
        // For this implementation, we'll use a simple threshold based on the current indoor temperature
        // You may want to replace this with a more sophisticated check using external temperature data
        
        // Define the minimum outdoor temperature for running the AC (in Celsius)
        // Use the configuration value if available, otherwise use the default
        const MIN_OUTDOOR_TEMP_C = this.platform.config.minOutdoorTempC !== undefined ? 
            this.platform.config.minOutdoorTempC : 18.3; // About 65°F

        const outdoorTemp = this.getOutdoorTemperature();
        
        this.log.debug(`Outdoor temperature: ${outdoorTemp}°C, Minimum required: ${MIN_OUTDOOR_TEMP_C}°C`);
        return outdoorTemp < MIN_OUTDOOR_TEMP_C;
    }
    
    // Get outdoor temperature from OpenWeatherMap API
    getOutdoorTemperature() {
        // If we have a cached temperature that's less than 10 minutes old, use it
        const now = Date.now();
        if (this.cachedOutdoorTemp && this.cachedOutdoorTempTime && 
            (now - this.cachedOutdoorTempTime) < 10 * 60 * 1000) {
            return this.cachedOutdoorTemp;
        }
        
        // Default to a safe value if we can't determine the outdoor temperature
        // This will cause us to default to running the fan instead of the AC.
        let defaultTemp = 0; // About 32°F in Celsius
        
        // Check if we have OpenWeatherMap API key and location in config
        if (!this.platform.config.weatherApiKey) {
            this.log.debug('No OpenWeatherMap API key configured. Using default temperature.');
            return defaultTemp;
        }
        
        if (!this.platform.config.weatherLocation) {
            this.log.debug('No weather location configured. Using default temperature.');
            return defaultTemp;
        }
        
        // If we have cached coordinates, use them
        if (this.cachedCoordinates) {
            return this.getWeatherFromCoordinates(this.cachedCoordinates.lat, this.cachedCoordinates.lon);
        }
        
        // Otherwise, get coordinates from location name
        const apiKey = this.platform.config.weatherApiKey;
        const location = this.platform.config.weatherLocation;
        
        // Use the Geocoding API to convert location to coordinates
        const axios = require('axios');
        const geocodingUrl = `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${apiKey}`;
        
        this.log.debug(`Getting coordinates for location: ${location}`);
        
        axios.get(geocodingUrl)
            .then(response => {
                if (response.data && response.data.length > 0) {
                    const lat = response.data[0].lat;
                    const lon = response.data[0].lon;
                    
                    this.log.debug(`Got coordinates: ${lat}, ${lon}`);
                    
                    // Cache the coordinates
                    this.cachedCoordinates = { lat, lon };
                    
                    // Get weather using coordinates
                    this.getWeatherFromCoordinates(lat, lon);
                } else {
                    this.log.error('Failed to get coordinates from location. Using default temperature.');
                }
            })
            .catch(error => {
                this.log.error(`Error getting coordinates: ${error.message}`);
            });
        
        // Return the cached temperature or default
        return this.cachedOutdoorTemp || defaultTemp;
    }
    
    getWeatherFromCoordinates(lat, lon) {
        const apiKey = this.platform.config.weatherApiKey;
        const axios = require('axios');
        
        // Use the One Call API to get current weather
        const weatherUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily,alerts&units=metric&appid=${apiKey}`;
        
        this.log.debug('Getting weather data from coordinates');
        
        axios.get(weatherUrl)
            .then(response => {
                if (response.data && response.data.current && response.data.current.temp !== undefined) {
                    const temp = response.data.current.temp;
                    this.log.debug(`Got outdoor temperature: ${temp}°C`);
                    
                    // Cache the temperature
                    this.cachedOutdoorTemp = temp;
                    this.cachedOutdoorTempTime = Date.now();
                } else {
                    this.log.error('Failed to get temperature from weather data. Using default temperature.');
                }
            })
            .catch(error => {
                this.log.error(`Error getting weather data: ${error.message}`);
            });
        
        // Return the cached temperature or default
        return this.cachedOutdoorTemp || 0;
    }

    getTargetHeatingCoolingMaxTemperature() {
        if (this.device.hvac_mode === 'range') {
            return this.device.target_temperature_high;
        } else {
            return this.device.target_temperature;
        }
    }

    setTargetTemperature(targetTemperature, callback) {
        this.conn.verbose('setTargetTemperature', this.device.hvac_mode, targetTemperature);

        let deviceType = 'shared';
        let setting = 'target_temperature';
        let mode = (this.isZirconium && this.device.hvac_mode == 'eco') ? this.device.previous_hvac_mode : this.device.hvac_mode;
        let promise = Promise.resolve();

        if (mode === 'eco') {
            if (this.platform.optionSet('Thermostat.EcoMode.ChangeEcoBands.Enable', this.device.serial_number, this.device.device_id)) {
                deviceType = 'device';
                if (this.device.away_temperature_low_enabled && !this.device.away_temperature_high_enabled) {
                    setting = 'away_temperature_low';
                } else if (this.device.away_temperature_high_enabled && !this.device.away_temperature_low_enabled) {
                    setting = 'away_temperature_high';
                } else {
                    return void callback();
                }
            } else {
                this.device.hvac_mode = this.device.previous_hvac_mode;
                promise = promise.then(() => this.setPropertyAsync('shared', 'hvac_mode', 'eco-off', 'target heating cooling', null, true));
            }
        } else if (mode === 'range') {
            return void callback();
        }

        this.log('Setting temperature to ' + this.formatAsDisplayTemperature(targetTemperature));
        return promise.then(() => this.setPropertyAsync(deviceType, setting, targetTemperature, 'target temperature')).asCallback(callback);
    }

    setCoolingThresholdTemperature(targetTemperature, callback) {
        this.conn.verbose('setCoolingThresholdTemperature', targetTemperature);

        let deviceType = 'shared';
        let setting = 'target_temperature_high';
        let mode = (this.isZirconium && this.device.hvac_mode == 'eco') ? this.device.previous_hvac_mode : this.device.hvac_mode;
        let promise = Promise.resolve();

        if (mode === 'eco') {
            if (this.platform.optionSet('Thermostat.EcoMode.ChangeEcoBands.Enable', this.device.serial_number, this.device.device_id)) {
                if (this.device.can_heat && this.device.can_cool) {
                    deviceType = 'device';
                    setting = 'away_temperature_high';
                } else {
                    return void callback();
                }
            } else {
                this.device.hvac_mode = this.device.previous_hvac_mode;
                promise = promise.then(() => this.setPropertyAsync('shared', 'hvac_mode', 'eco-off', 'target heating cooling', null, true));
            }
        }

        this.log('Setting cooling threshold temperature to ' + this.formatAsDisplayTemperature(targetTemperature));
        return promise.then(() => this.setPropertyAsync(deviceType, setting, targetTemperature, 'cooling threshold temperature')).asCallback(callback);
    }

    setHeatingThresholdTemperature(targetTemperature, callback) {
        this.conn.verbose('setHeatingThresholdTemperature', targetTemperature);

        let deviceType = 'shared';
        let setting = 'target_temperature_low';
        let mode = (this.isZirconium && this.device.hvac_mode == 'eco') ? this.device.previous_hvac_mode : this.device.hvac_mode;
        let promise = Promise.resolve();

        if (mode === 'eco') {
            if (this.platform.optionSet('Thermostat.EcoMode.ChangeEcoBands.Enable', this.device.serial_number, this.device.device_id)) {
                if (this.device.can_heat && this.device.can_cool) {
                    deviceType = 'device';
                    setting = 'away_temperature_low';
                } else {
                    return void callback();
                }
            } else {
                this.device.hvac_mode = this.device.previous_hvac_mode;
                promise = promise.then(() => this.setPropertyAsync('shared', 'hvac_mode', 'eco-off', 'target heating cooling', null, true));
            }
        }

        this.log('Setting heating threshold temperature to ' + this.formatAsDisplayTemperature(targetTemperature));
        return promise.then(() => this.setPropertyAsync(deviceType, setting, targetTemperature, 'heating threshold temperature')).asCallback(callback);
    }
}

class FanTimerActive extends Characteristic {
    constructor() {
        super('Fan Timer Active', 'D6D47D29-4640-4F44-B53C-D84015DAEBDB');

        this.setProps({
            format: hap.Formats.BOOL,
            perms: [hap.Perms.READ, hap.Perms.WRITE, hap.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    }
}

class FanTimerDuration extends Characteristic {
    constructor() {
        super('Fan Timer Duration', 'D6D47D29-4641-4F44-B53C-D84015DAEBDB');

        this.setProps({
            format: hap.Formats.UINT16,
            unit: hap.Units.MINUTES,
            maxValue: 24 * 60,
            minValue: 0,
            minStep: 15,
            perms: [hap.Perms.READ, hap.Perms.WRITE, hap.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    }
}

class HasLeaf extends Characteristic {
    constructor() {
        super('Has Leaf', 'D6D47D29-4642-4F44-B53C-D84015DAEBDB');

        this.setProps({
            format: hap.Formats.BOOL,
            perms: [hap.Perms.READ, hap.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    }
}

class SunlightCorrectionEnabled extends Characteristic {
    constructor() {
        super('Sunlight Correction Enabled', 'D6D47D29-4644-4F44-B53C-D84015DAEBDB');

        this.setProps({
            format: hap.Formats.BOOL,
            perms: [hap.Perms.READ, hap.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    }
}

class SunlightCorrectionActive extends Characteristic {
    constructor() {
        super('Sunlight Correction Active', 'D6D47D29-4645-4F44-B53C-D84015DAEBDB');

        this.setProps({
            format: hap.Formats.BOOL,
            perms: [hap.Perms.READ, hap.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    }
}

class UsingEmergencyHeat extends Characteristic {
    constructor() {
        super('Using Emergency Heat', 'D6D47D29-4646-4F44-B53C-D84015DAEBDB');

        this.setProps({
            format: hap.Formats.BOOL,
            perms: [hap.Perms.READ, hap.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    }
}

module.exports = function() {
    Object.keys(nestDeviceDescriptor).forEach(key => NestThermostatAccessory[key] = NestThermostatAccessory.prototype[key] = nestDeviceDescriptor[key]);
    return NestThermostatAccessory;
};
