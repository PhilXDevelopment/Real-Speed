const fs = require('fs/promises');
const path = require('path');
const {
  withDangerousMod,
  withMainApplication
} = require('expo/config-plugins');

const notificationModule = `package com.realspeed.dashboard

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

class RealSpeedTripNotificationModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "RealSpeedTripNotification"

  @ReactMethod
  fun update(speed: String, unit: String, elapsed: String, mode: String, status: String) {
    val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Live trip", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Live speed and elapsed time during an active trip"
          setShowBadge(false)
          enableVibration(false)
          setSound(null, null)
        }
      )
    }

    val launchIntent = reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        reactContext,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or
          (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
      )
    }
    val rideMode = mode.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
    val details = if (status == "recording") {
      "$speed $unit  ·  $elapsed elapsed"
    } else if (status == "paused") {
      "Ride paused  ·  $elapsed elapsed"
    } else {
      "Ride interrupted  ·  $elapsed elapsed"
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(reactContext, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(reactContext)
    }
    builder
      .setSmallIcon(R.drawable.ic_stat_realspeed)
      .setContentTitle("RealSpeed · $rideMode")
      .setContentText(details)
      .setStyle(Notification.BigTextStyle().bigText(details).setSummaryText("$rideMode ride · GPS active"))
      .setSubText("Live trip")
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setWhen(0)
    if (contentIntent != null) builder.setContentIntent(contentIntent)
    manager.notify(NOTIFICATION_ID, builder.build())
  }

  @ReactMethod
  fun dismiss() {
    val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancel(NOTIFICATION_ID)
  }

  companion object {
    private const val CHANNEL_ID = "realspeed-live-trip"
    private const val NOTIFICATION_ID = 4317
  }
}

class RealSpeedTripNotificationPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext) =
    listOf(RealSpeedTripNotificationModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;

const notificationIcon = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
  android:width="24dp"
  android:height="24dp"
  android:viewportWidth="24"
  android:viewportHeight="24">
  <path
    android:fillColor="#FFFFFFFF"
    android:pathData="M2,17 C2,8.7 6.5,3 12,3 C17.5,3 22,8.7 22,17 L19,17 C19,10.5 16,6 12,6 C8,6 5,10.5 5,17 Z M10.8,15.2 L17,9 L14.7,16.6 L12,17 Z" />
</vector>
`;

module.exports = function withRealSpeedTripNotification(config) {
  const packageName = config.android?.package;
  config = withMainApplication(config, (mod) => {
    const registration = 'add(RealSpeedTripNotificationPackage())';
    if (!mod.modResults.contents.includes(registration)) {
      const packageList = 'PackageList(this).packages.apply {';
      if (!mod.modResults.contents.includes(packageList)) {
        throw new Error('Unable to register RealSpeedTripNotificationPackage in MainApplication.');
      }
      mod.modResults.contents = mod.modResults.contents.replace(
        packageList,
        `${packageList}\n          ${registration}`
      );
    }
    return mod;
  });

  return withDangerousMod(config, [
    'android',
    async (mod) => {
      if (!packageName) {
        throw new Error('Set android.package to generate the RealSpeed notification module.');
      }
      const sourceDirectory = path.join(
        mod.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        ...packageName.split('.')
      );
      const drawableDirectory = path.join(
        mod.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'drawable'
      );
      await fs.mkdir(sourceDirectory, { recursive: true });
      await fs.mkdir(drawableDirectory, { recursive: true });
      await fs.writeFile(path.join(sourceDirectory, 'RealSpeedTripNotificationModule.kt'), notificationModule);
      await fs.writeFile(path.join(drawableDirectory, 'ic_stat_realspeed.xml'), notificationIcon);
      return mod;
    }
  ]);
};
