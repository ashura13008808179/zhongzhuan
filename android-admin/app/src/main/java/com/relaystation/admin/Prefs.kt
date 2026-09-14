package com.relaystation.admin

import android.content.Context

class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("relay_admin", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = sp.getString("baseUrl", "") ?: ""
        set(v) { sp.edit().putString("baseUrl", v.trim().trimEnd('/')).apply() }

    var token: String
        get() = sp.getString("token", "") ?: ""
        set(v) { sp.edit().putString("token", v).apply() }

    var lastNotifyIds: Set<String>
        get() = sp.getStringSet("lastNotifyIds", emptySet()) ?: emptySet()
        set(v) { sp.edit().putStringSet("lastNotifyIds", v).apply() }

    var seeded: Boolean
        get() = sp.getBoolean("seeded", false)
        set(v) { sp.edit().putBoolean("seeded", v).apply() }
}
