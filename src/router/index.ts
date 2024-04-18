import {createRouter, createWebHashHistory, RouteRecordRaw, RouterOptions} from "vue-router";

const routes: Array<any> = [
    {
        path: "/",
        name: "index",
        redirect: "/dashboard",
        meta: {
            // 是否缓存数据
            keepAlive: true,
        }
    },
    {
        path: "/dashboard",
        name: "dashboard",
        component: () => import("@/views/dashboard/Index.vue"),
        children:
            [
                {
                    path: '/dashboard',
                    name: 'dashboard',
                    component: () => import("@/views/home/Index.vue"),
                    meta: {
                        keepAlive: true,
                    }
                }
            ],
    }
];


const router = createRouter({
    history: createWebHashHistory(),
    parseQuery: true,
    routes: routes,
    scrollBehavior: () => ({y: 0}),
} as RouterOptions);

export default router;