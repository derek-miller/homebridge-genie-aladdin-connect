import { Characteristic, CharacteristicValue, HAP, Logger, PlatformAccessory } from 'homebridge';

import { GenieAladdinConnectHomebridgePlatform } from './platform';
import {
  AladdinConnect,
  AladdinDesiredDoorStatus,
  AladdinDoor,
  AladdinDoorStatus,
  AladdinDoorStatusInfo,
} from './aladdinConnect';
import { DEFAULT_STATUS_LOW_BATTERY_PERCENT } from './settings';

export interface GenieAladdinConnectPlatformAccessoryContext {
  door: AladdinDoor;
}

export class GenieAladdinConnectGarageDoorAccessory {
  private readonly log: Logger;
  private readonly hap: HAP;
  private readonly aladdinConnect: AladdinConnect;
  private readonly context: GenieAladdinConnectPlatformAccessoryContext;
  private readonly door: AladdinDoor;
  private readonly id: string;
  private readonly targetStateCharacteristic: Characteristic;
  private readonly currentStateCharacteristic: Characteristic;
  private readonly obstructionDetectedCharacteristic: Characteristic;
  private readonly batteryLevelCharacteristic: Characteristic | null = null;
  private readonly statusLowBatteryCharacteristic: Characteristic | null = null;

  private _currentStatus = AladdinDoorStatus.UNKNOWN;
  private _desiredStatus = AladdinDesiredDoorStatus.NONE;
  private _obstructionDetected = false;
  private _batteryLevel = 100;
  private _statusLowBattery = false;

  constructor(
    private readonly platform: GenieAladdinConnectHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.log = this.platform.log;
    this.hap = this.platform.api.hap;
    this.aladdinConnect = this.platform.aladdinConnect;
    this.context = <GenieAladdinConnectPlatformAccessoryContext>this.accessory.context;
    this.door = this.context.door;
    this.id = `${this.door.deviceId}:${this.door.index}`;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Genie')
      .setCharacteristic(this.platform.Characteristic.Model, 'Aladdin Connect')
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        `${this.door.serialNumber}:${this.door.index}`,
      );

    const service = (this.accessory.getService(this.platform.Service.GarageDoorOpener) ||
      this.accessory.addService(
        this.platform.Service.GarageDoorOpener,
        this.door.name,
        this.id,
      ))!.setCharacteristic(this.platform.Characteristic.Name, this.door.name);

    this.targetStateCharacteristic = service
      .getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onSet(this.setTargetDoorState.bind(this))
      .onGet(this.getTargetDoorState.bind(this));
    this.currentStateCharacteristic = service
      .getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));
    this.obstructionDetectedCharacteristic = service
      .getCharacteristic(this.platform.Characteristic.ObstructionDetected)
      .onGet(this.getObstructionDetected.bind(this));
    if (this.door.hasBatteryLevel) {
      this.batteryLevelCharacteristic = service
        .getCharacteristic(this.platform.Characteristic.BatteryLevel)
        .onGet(this.getBatteryLevel.bind(this));
      this.statusLowBatteryCharacteristic = service
        .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));
    }

    this.aladdinConnect.subscribe(this.door, (info: AladdinDoorStatusInfo) => {
      this.currentStatus = info.status;
      this.obstructionDetected =
        // A fault happens when a door fails to open/close twice in a row and then must be operated
        // manually.
        info.fault ||
        // If the door does not go into its desired state after some timeout it goes into one of
        // these states. The first time it is recoverable.
        [AladdinDoorStatus.TIMEOUT_CLOSING, AladdinDoorStatus.TIMEOUT_OPENING].includes(
          info.status,
        );
      if (this.door.hasBatteryLevel && info.batteryPercent !== null) {
        this.batteryLevel = info.batteryPercent;
      }
      // If the desired status is NONE or an obstruction is detected, derive it from the current
      // status.
      this.desiredStatus =
        info.desiredStatus === AladdinDesiredDoorStatus.NONE || this.obstructionDetected
          ? this.convertStatusToDesiredStatus(this.currentStatus)
          : info.desiredStatus;
    });
  }

  private get currentStatus(): AladdinDoorStatus {
    return this._currentStatus;
  }

  private set currentStatus(value: AladdinDoorStatus) {
    if (this._currentStatus === value) {
      return;
    }
    this.log.debug(
      '[%s] Update Characteristic CurrentDoorState: %s -> %s',
      this.door.name,
      AladdinDoorStatus[this._currentStatus],
      AladdinDoorStatus[value],
    );
    this._currentStatus = value;
    this.currentStateCharacteristic.updateValue(
      this.convertStatusToCurrentStateValue(this._currentStatus),
    );
  }

  private get desiredStatus(): AladdinDesiredDoorStatus {
    return this._desiredStatus;
  }

  private set desiredStatus(value: AladdinDesiredDoorStatus) {
    if (this._desiredStatus === value) {
      return;
    }
    this.log.debug(
      '[%s] Update Characteristic TargetDoorState: %s -> %s',
      this.door.name,
      AladdinDesiredDoorStatus[this._desiredStatus],
      AladdinDesiredDoorStatus[value],
    );
    this._desiredStatus = value;
    this.targetStateCharacteristic.updateValue(
      this.convertDesiredStatusToTargetStateValue(this._desiredStatus),
    );
  }

  private get obstructionDetected(): boolean {
    return this._obstructionDetected;
  }

  private set obstructionDetected(value: boolean) {
    if (this._obstructionDetected === value) {
      return;
    }
    this.log.debug(
      '[%s] Update Characteristic ObstructionDetected: %s -> %s',
      this.door.name,
      this._obstructionDetected ? 'YES' : 'NO',
      value ? 'YES' : 'NO',
    );
    this._obstructionDetected = value;
    this.obstructionDetectedCharacteristic.updateValue(this._obstructionDetected);
  }

  private get batteryLevel(): number {
    return this._batteryLevel;
  }

  private set batteryLevel(value: number) {
    const batteryLevel = Math.min(100, Math.max(0, value));
    const statusLowBattery =
      batteryLevel <= (this.platform.config?.batteryLowLevel ?? DEFAULT_STATUS_LOW_BATTERY_PERCENT);

    if (this._batteryLevel !== batteryLevel && this.batteryLevelCharacteristic !== null) {
      this.log.debug(
        '[%s] Update Characteristic BatteryLevel: %s -> %s',
        this.door.name,
        this._batteryLevel,
        batteryLevel,
      );
      this.batteryLevelCharacteristic.updateValue(batteryLevel);
    }
    this._batteryLevel = batteryLevel;

    if (
      this._statusLowBattery !== statusLowBattery &&
      this.statusLowBatteryCharacteristic !== null
    ) {
      this.log.debug(
        '[%s] Update Characteristic StatusLowBattery: %s -> %s',
        this.door.name,
        this._statusLowBattery ? 'YES' : 'NO',
        statusLowBattery ? 'YES' : 'NO',
      );
      this.statusLowBatteryCharacteristic.updateValue(this._statusLowBattery);
    }
    this._statusLowBattery = statusLowBattery;
  }

  private async setTargetDoorState(value: CharacteristicValue): Promise<void> {
    const desiredStatus = this.convertTargetStateValueToDesiredStatus(value);
    if (desiredStatus === this.desiredStatus) {
      this.log.debug(
        '[%s] Set Characteristic TargetDoorState -> %s, already set TargetDoorState -> %s. Cancelling.',
        this.door.name,
        AladdinDesiredDoorStatus[desiredStatus],
        AladdinDoorStatus[this.desiredStatus],
      );
      return;
    }
    this.log.debug(
      '[%s] Set Characteristic TargetDoorState ->',
      this.door.name,
      AladdinDesiredDoorStatus[desiredStatus],
    );
    try {
      await this.aladdinConnect.setDoorStatus(this.door, desiredStatus);
    } catch (error: unknown) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async getTargetDoorState(): Promise<CharacteristicValue> {
    this.log.debug(
      '[%s] Get Characteristic TargetDoorState ->',
      this.door.name,
      AladdinDesiredDoorStatus[this.desiredStatus],
    );
    return this.convertDesiredStatusToTargetStateValue(this.desiredStatus);
  }

  private getCurrentDoorState(): CharacteristicValue {
    this.log.debug(
      '[%s] Get Characteristic CurrentDoorState ->',
      this.door.name,
      AladdinDoorStatus[this.currentStatus],
    );
    return this.convertStatusToCurrentStateValue(this.currentStatus);
  }

  private getObstructionDetected(): CharacteristicValue {
    this.log.debug(
      '[%s] Get Characteristic ObstructionDetected ->',
      this.door.name,
      this.obstructionDetected ? 'YES' : 'NO',
    );
    return this.obstructionDetected;
  }

  private getBatteryLevel(): CharacteristicValue {
    this.log.debug('[%s] Get Characteristic BatteryLevel ->', this.door.name, this.batteryLevel);
    return this.batteryLevel;
  }

  private getStatusLowBattery(): CharacteristicValue {
    this.log.debug(
      '[%s] Get Characteristic StatusLowBattery ->',
      this.door.name,
      this._statusLowBattery ? 'YES' : 'NO',
    );
    return this._statusLowBattery;
  }

  private convertTargetStateValueToDesiredStatus(
    value: CharacteristicValue,
  ): AladdinDesiredDoorStatus {
    switch (value) {
      case this.platform.Characteristic.TargetDoorState.OPEN:
        return AladdinDesiredDoorStatus.OPEN;
      case this.platform.Characteristic.TargetDoorState.CLOSED:
        return AladdinDesiredDoorStatus.CLOSED;
      default:
        this.log.debug(
          '[%s] Unknown TargetDoorState Characteristic value -> %d',
          this.door.name,
          value,
        );
        throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }

  private convertStatusToCurrentStateValue(status: AladdinDoorStatus): CharacteristicValue {
    switch (status) {
      case AladdinDoorStatus.OPEN:
        return this.platform.Characteristic.CurrentDoorState.OPEN;
      case AladdinDoorStatus.OPENING:
        return this.platform.Characteristic.CurrentDoorState.OPENING;
      case AladdinDoorStatus.CLOSED:
        return this.platform.Characteristic.CurrentDoorState.CLOSED;
      case AladdinDoorStatus.CLOSING:
        return this.platform.Characteristic.CurrentDoorState.CLOSING;
      case AladdinDoorStatus.TIMEOUT_OPENING:
      case AladdinDoorStatus.TIMEOUT_CLOSING:
      case AladdinDoorStatus.UNKNOWN:
      case AladdinDoorStatus.NOT_CONFIGURED:
        return this.platform.Characteristic.CurrentDoorState.STOPPED;
      default:
        this.log.debug('[%s] Unknown Aladdin door status -> %d', this.door.name, status);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }

  private convertDesiredStatusToTargetStateValue(
    status: AladdinDesiredDoorStatus,
  ): CharacteristicValue {
    switch (status) {
      case AladdinDesiredDoorStatus.OPEN:
        return this.platform.Characteristic.TargetDoorState.OPEN;
      case AladdinDesiredDoorStatus.CLOSED:
        return this.platform.Characteristic.TargetDoorState.CLOSED;
      default:
        this.log.debug('[%s] Unknown Aladdin door desired status -> %d', this.door.name, status);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }

  private convertStatusToDesiredStatus(status: AladdinDoorStatus): AladdinDesiredDoorStatus {
    switch (status) {
      case AladdinDoorStatus.OPEN:
      case AladdinDoorStatus.OPENING:
      case AladdinDoorStatus.TIMEOUT_OPENING:
        return AladdinDesiredDoorStatus.OPEN;
      case AladdinDoorStatus.CLOSED:
      case AladdinDoorStatus.CLOSING:
      case AladdinDoorStatus.TIMEOUT_CLOSING:
        return AladdinDesiredDoorStatus.CLOSED;
      case AladdinDoorStatus.UNKNOWN:
      case AladdinDoorStatus.NOT_CONFIGURED:
        return AladdinDesiredDoorStatus.NONE;
      default:
        this.log.debug('[%s] Unknown Aladdin door status -> %d', this.door.name, status);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }
}
