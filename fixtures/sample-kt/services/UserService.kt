class UserService {
    private val users = mutableListOf<User>()

    fun addUser(user: User) {
        users.add(user)
    }

    fun findByName(name: String): User? {
        return users.find { it.name == name }
    }
}
